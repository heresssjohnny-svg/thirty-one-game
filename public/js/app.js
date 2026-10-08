// public/js/app.js - Application Lifecycle, Auth State & Persistence Coordinator

// -------------------------------------------------------------
// 1. SESSION & AUTHENTICATION STATE
// -------------------------------------------------------------
try {
    window.userSession = JSON.parse(localStorage.getItem('31_user_session') || 'null');
} catch (e) {
    window.userSession = null;
}

/**
 * Toggles visibility between the pre-menu Auth Screen and the Lobby Menu,
 * ensuring seamless transitions across web and mobile viewports.
 */
window.updateViewForAuth = function() {
    const authScreen = document.getElementById('auth-screen');
    const mainMenu = document.getElementById('main-menu');
    const gameView = document.getElementById('game-view');
    const displayUser = document.getElementById('auth-display-user');
    const guestBadge = document.getElementById('auth-guest-badge');
    const usernameInput = document.getElementById('username-input');

    if (window.userSession && window.userSession.id) {
        if (authScreen) authScreen.style.display = 'none';
        
        // Show main menu only if not currently seated at an active table
        if (!window.appGlobals?.currentJoinedCode) {
            if (mainMenu) mainMenu.style.display = 'flex';
            if (gameView) gameView.style.display = 'none';
        }

        if (displayUser) displayUser.innerText = window.userSession.username || 'Player';
        if (guestBadge) guestBadge.style.display = window.userSession.isGuest ? 'inline' : 'none';

        // Auto-fill lobby display handle from session if not already typed
        if (usernameInput && (!usernameInput.value || usernameInput.value === 'Player1')) {
            usernameInput.value = window.userSession.username || 'Player1';
            window.saveInputs();
        }

        if (window.clientState) {
            window.clientState.username = usernameInput ? usernameInput.value.trim() : (window.userSession.username || 'Player1');
        }

        // Establish socket connection and load lobbies once logged in
        if (typeof connectSocket === 'function') connectSocket();
        if (typeof refreshLobbies === 'function') refreshLobbies();
    } else {
        if (authScreen) authScreen.style.display = 'flex';
        if (mainMenu) mainMenu.style.display = 'none';
        if (gameView) gameView.style.display = 'none';
    }
};

/**
 * Submits Native 31 Registration or Login credentials
 */
window.handleAuthSubmit = async function(type) {
    const usernameInput = document.getElementById('auth-username');
    const emailInput = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (type === 'register' && (!username || !email || !password)) {
        return alert("Username, email, and password are all required to sign up.");
    }
    if (type === 'login' && (!email || !password)) {
        return alert("Email and password are required to log in.");
    }

    try {
        const endpoint = type === 'register' ? '/auth/register' : '/auth/login';
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });

        const data = await res.json();
        if (!res.ok || data.error) {
            return alert(data.error || "Authentication failed. Please verify credentials.");
        }

        localStorage.setItem('31_jwt', data.token);
        localStorage.setItem('31_user_session', JSON.stringify(data.user));
        window.userSession = data.user;

        window.updateViewForAuth();
    } catch (err) {
        console.error("Auth submit error:", err);
        alert("Cannot connect to server. Please verify your internet connection or server status.");
    }
};

/**
 * Creates an ephemeral guest account (No persistent lifetime storage)
 */
window.handleGuestLogin = async function() {
    const usernameInput = document.getElementById('auth-username');
    const customName = usernameInput ? usernameInput.value.trim() : '';

    try {
        const res = await fetch('/auth/guest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: customName })
        });

        const data = await res.json();
        if (!res.ok || data.error) return alert(data.error || "Could not start guest session.");

        localStorage.setItem('31_jwt', data.token);
        localStorage.setItem('31_user_session', JSON.stringify(data.user));
        window.userSession = data.user;

        window.updateViewForAuth();
    } catch (err) {
        console.error("Guest login error:", err);
        alert("Server unreachable. Please check if backend is online.");
    }
};

/**
 * Handles Social Login (Google, Facebook, Instagram)
 */
window.triggerSocialLogin = async function(provider) {
    const handle = prompt(`Enter your ${provider.charAt(0).toUpperCase() + provider.slice(1)} handle or display name:`);
    if (!handle || !handle.trim()) return;

    // Generates a consistent or simulated provider identifier
    let providerId = localStorage.getItem(`31_${provider}_id`);
    if (!providerId) {
        providerId = `${provider}_${Math.floor(100000 + Math.random() * 900000)}`;
        localStorage.setItem(`31_${provider}_id`, providerId);
    }

    try {
        const res = await fetch('/auth/social', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider,
                providerId,
                username: handle.trim()
            })
        });

        const data = await res.json();
        if (!res.ok || data.error) return alert(data.error || "Social authentication failed.");

        localStorage.setItem('31_jwt', data.token);
        localStorage.setItem('31_user_session', JSON.stringify(data.user));
        window.userSession = data.user;

        window.updateViewForAuth();
    } catch (err) {
        console.error("Social login request failed:", err);
        alert("Social sign-in failed. Please verify server connectivity.");
    }
};

/**
 * Clears active tokens and resets to the Auth screen
 */
window.logout = function() {
    localStorage.removeItem('31_jwt');
    localStorage.removeItem('31_user_session');
    window.userSession = null;

    if (window.appGlobals?.ws) {
        try { window.appGlobals.ws.close(); } catch (e) {}
    }

    window.updateViewForAuth();
};

// -------------------------------------------------------------
// 2. LIFETIME LEDGER & CREDIT OFFSETS
// -------------------------------------------------------------
window.openLifetimeLedgerModal = function() {
    if (!window.userSession || window.userSession.isGuest) {
        alert("Guest accounts do not retain lifetime records. Create or log in with an account to track all-time balances.");
        return;
    }

    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') {
        sendFunc({ type: 'GET_LIFETIME_LEDGER' });
    }
};

window.renderLifetimeLedger = function(balances) {
    const container = document.getElementById('lifetime-ledger-content');
    if (!container) return;

    if (!balances || balances.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); padding:6px;">No lifetime debts or credits recorded yet.</div>';
        if (typeof toggleModal === 'function') toggleModal('lifetime-ledger-modal');
        return;
    }

    let html = '<ul style="list-style:none; padding:0; margin:0;">';
    balances.forEach((b) => {
        const owesMe = b.net > 0;
        const absVal = Math.abs(b.net).toFixed(2);

        html += `
            <li style="margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; align-items:center;">
                <div style="text-align:left;">
                    <b>${b.username}</b>: 
                    <span style="color:${owesMe ? '#34d399' : '#f87171'}; font-weight:bold;">
                        ${owesMe ? `owes you $${absVal}` : `you owe $${absVal}`}
                    </span>
                </div>
                ${owesMe ? `
                    <div style="display:flex; gap:4px; align-items:center;">
                        <input type="number" id="credit-input-${b.other_id}" placeholder="$" style="width:48px; font-size:0.7rem; padding:2px;" min="1" max="${absVal}" />
                        <button style="font-size:0.65rem; padding:2px 6px; background:#10b981; border-color:#34d399;" onclick="applyCreditToUser('${b.other_id}')">Apply Credit</button>
                    </div>
                ` : ''}
            </li>
        `;
    });
    html += '</ul>';

    container.innerHTML = html;
    if (typeof toggleModal === 'function') toggleModal('lifetime-ledger-modal');
};

window.applyCreditToUser = function(debtorId) {
    const input = document.getElementById(`credit-input-${debtorId}`);
    const amount = parseFloat(input?.value);

    if (!amount || isNaN(amount) || amount <= 0) {
        return alert("Please enter a valid credit dollar amount greater than 0.");
    }

    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') {
        sendFunc({ type: 'APPLY_CREDIT', debtorId, amount });
    }
};

// -------------------------------------------------------------
// 3. PERSISTENCE & LOCAL STORAGE INPUT HANDLERS
// -------------------------------------------------------------
window.saveInputs = function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        if (u) {
            localStorage.setItem('saved_username', u.value);
            localStorage.setItem('blitz31_username', u.value);
            if (window.clientState) window.clientState.username = u.value.trim() || 'Player1';
        }
        if (l) {
            localStorage.setItem('saved_lobby_name', l.value);
            localStorage.setItem('blitz31_lobby_name', l.value);
        }
    } catch (e) {}
};

window.restoreSavedInputs = function() {
    try {
        const u = document.getElementById('username-input');
        const l = document.getElementById('lobby-name-input');
        const savedU = localStorage.getItem('saved_username') || localStorage.getItem('blitz31_username');
        const savedL = localStorage.getItem('saved_lobby_name') || localStorage.getItem('blitz31_lobby_name');

        if (u && savedU) u.value = savedU;
        if (l && savedL) l.value = savedL;

        if (window.clientState && u) {
            window.clientState.username = u.value.trim() || 'Player1';
        }
    } catch (e) {}
};

// -------------------------------------------------------------
// 4. BROWSER LIFECYCLE WATCHDOG (Mobile Background / Tab Recovery)
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    window.restoreSavedInputs();
    window.updateViewForAuth();
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && window.userSession) {
        const ws = window.appGlobals?.ws || window.ws;
        const sendFunc = window.initSocketAndSend || window.sendSocketMessage;

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (typeof connectSocket === 'function') connectSocket();
        } else if (window.appGlobals?.currentJoinedCode && typeof sendFunc === 'function') {
            const usernameInput = document.getElementById('username-input');
            const username = usernameInput ? usernameInput.value.trim() : (window.clientState?.username || 'Player1');

            sendFunc({
                type: 'JOIN_LOBBY',
                code: window.appGlobals.currentJoinedCode,
                username: username
            });
        }
    }
});

window.addEventListener('pageshow', () => {
    if (window.userSession) {
        const ws = window.appGlobals?.ws || window.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (typeof connectSocket === 'function') connectSocket();
        }
    }
});
