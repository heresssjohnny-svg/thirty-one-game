// public/js/ledger.js - Lifetime SQLite Ledger & In-Game Session Balances

// -------------------------------------------------------------
// 1. ALL-TIME LIFETIME LEDGER (SQLITE)
// -------------------------------------------------------------
window.openLifetimeLedgerModal = function() {
    // 1. Open the modal immediately so the player gets instant visual feedback
    if (typeof window.toggleModal === 'function') {
        window.toggleModal('lifetime-ledger-modal');
    } else {
        const modal = document.getElementById('lifetime-ledger-modal');
        if (modal) modal.style.display = 'flex';
    }

    const content = document.getElementById('lifetime-ledger-content');
    if (content) {
        content.innerHTML = '<div style="text-align:center; padding:12px; color:var(--text-muted); font-size:0.75rem;">Loading lifetime records...</div>';
    }

    // 2. Identify active session credentials
    const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token') || null;
    const activeUsername = (
        (window.userSession && window.userSession.username) ||
        document.getElementById('auth-display-user')?.innerText ||
        document.getElementById('username-input')?.value ||
        (window.clientState && window.clientState.username) ||
        'Player1'
    ).trim();

    const userId = (window.userSession && window.userSession.userId) || null;
    const isGuest = !!((window.userSession && window.userSession.isGuest) || (!token && !userId));

    // 3. Dispatch query to backend WebSocket router
    const sendPayload = {
        type: 'GET_LIFETIME_LEDGER',
        token,
        userId,
        username: activeUsername,
        isGuest
    };

    if (typeof window.sendSocketMessage === 'function') {
        window.sendSocketMessage(sendPayload);
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(sendPayload));
    }
};

window.renderLifetimeLedgerData = function(balances, isGuest) {
    const container = document.getElementById('lifetime-ledger-content');
    if (!container) return;

    if (isGuest) {
        container.innerHTML = `
            <div style="background:rgba(239, 68, 68, 0.15); border:1px solid #ef4444; border-radius:8px; padding:10px; color:#fca5a5; font-size:0.75rem; line-height:1.4;">
                ⚠️ <b>Playing as Guest:</b><br>
                Match history and tournament debts are only permanently tracked for registered accounts. Create an account or log in from the main menu to retain your lifetime ledger.
            </div>
        `;
        return;
    }

    if (!balances || !Array.isArray(balances) || balances.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; color:var(--text-muted); padding:16px 8px; font-size:0.78rem;">
                No lifetime balance records or outstanding debts found for your profile.
            </div>
        `;
        return;
    }

    let html = '<div style="display:flex; flex-direction:column; gap:6px;">';
    balances.forEach(b => {
        const opponent = b.opponent || b.username || b.otherUser || 'Opponent';
        const net = Number(b.net !== undefined ? b.net : (b.balance || 0));
        const isPositive = net > 0;
        const isEven = net === 0;

        const color = isEven ? '#94a3b8' : (isPositive ? '#34d399' : '#f87171');
        const sign = isPositive ? '+' : '';
        const statusText = isEven ? 'Even ($0)' : (isPositive ? `+ $${net} (Owes you)` : `- $${Math.abs(net)} (You owe)`);

        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(15, 23, 42, 0.75); border:1px solid rgba(250, 204, 21, 0.25); padding:8px 10px; border-radius:6px;">
                <span style="font-weight:bold; color:var(--text-main); font-size:0.82rem;">${opponent}</span>
                <span style="font-weight:900; color:${color}; font-size:0.85rem;">${statusText}</span>
            </div>
        `;
    });
    html += '</div>';

    container.innerHTML = html;
};

// Aliases for compatibility
window.renderLifetimeLedger = window.renderLifetimeLedgerData;
window.renderLifetimeBalances = window.renderLifetimeLedgerData;

// -------------------------------------------------------------
// 2. IN-GAME SESSION LEDGER
// -------------------------------------------------------------
window.openLedgerModal = function() {
    const container = document.getElementById('ledger-content');
    const state = window.clientState || {};
    const mainGame = state.mainGameLedger || {};
    const sideBets = state.sideBetLedger || {};
    const botBets = state.botBetLedger || {};

    let html = '';
    const hasMain = Object.keys(mainGame).length > 0;
    const hasSide = Object.keys(sideBets).length > 0;
    const hasBot = Object.keys(botBets).length > 0;

    if (!hasMain && !hasSide && !hasBot) {
        if (container) container.innerHTML = '<div style="color:var(--text-muted); padding:8px; text-align:center;">No wagers recorded for this lobby session yet.</div>';
    } else {
        if (hasMain) {
            html += '<div style="font-weight:bold; color:var(--accent-gold); margin-bottom:4px; font-size:0.8rem;">Main Match Debts:</div>';
            html += formatLedgerSection(mainGame);
        }
        if (hasSide) {
            html += '<div style="font-weight:bold; color:var(--accent-cyan); margin-top:8px; margin-bottom:4px; font-size:0.8rem;">Side Bet Debts:</div>';
            html += formatLedgerSection(sideBets);
        }
        if (hasBot) {
            html += '<div style="font-weight:bold; color:#a78bfa; margin-top:8px; margin-bottom:4px; font-size:0.8rem;">Bot Match Debts:</div>';
            html += formatLedgerSection(botBets);
        }
        if (container) container.innerHTML = html;
    }

    if (typeof window.toggleModal === 'function') {
        window.toggleModal('ledger-modal');
    } else {
        const modal = document.getElementById('ledger-modal');
        if (modal) modal.style.display = 'flex';
    }
};

function formatLedgerSection(ledgerObj) {
    let out = '<div style="display:flex; flex-direction:column; gap:4px; margin-bottom:6px;">';
    for (const debtor in ledgerObj) {
        for (const creditor in ledgerObj[debtor]) {
            const amt = ledgerObj[debtor][creditor];
            if (amt > 0) {
                out += `
                    <div style="display:flex; justify-content:space-between; background:rgba(15,23,42,0.65); padding:4px 8px; border-radius:4px; border:1px solid rgba(255,255,255,0.08); font-size:0.75rem;">
                        <span><b>${debtor}</b> owes <b>${creditor}</b>:</span>
                        <span style="color:var(--accent-gold); font-weight:bold;">$${amt}</span>
                    </div>
                `;
            }
        }
    }
    out += '</div>';
    return out;
}

// -------------------------------------------------------------
// 3. LEDGER SCREENSHOT CAPTURE
// -------------------------------------------------------------
window.saveLedgerScreenshot = function() {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    // Draw casino felt background
    ctx.fillStyle = '#044e36';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);

    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('31! LOBBY SESSION LEDGER', canvas.width / 2, 40);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px sans-serif';
    ctx.fillText(`Recorded on ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`, canvas.width / 2, 62);

    ctx.textAlign = 'left';
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#ffffff';

    const mainGame = (window.clientState && window.clientState.mainGameLedger) || {};
    let y = 100;
    let count = 0;

    for (const debtor in mainGame) {
        for (const creditor in mainGame[debtor]) {
            const amt = mainGame[debtor][creditor];
            if (amt > 0 && y < 320) {
                ctx.fillText(`• ${debtor} owes ${creditor}: $${amt}`, 36, y);
                y += 24;
                count++;
            }
        }
    }

    if (count === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText('No outstanding wagers recorded this session.', 36, y);
    }

    const dataUrl = canvas.toDataURL('image/png');
    const previewImg = document.getElementById('screenshot-preview-img');
    const downloadLink = document.getElementById('screenshot-download-link');

    if (previewImg) previewImg.src = dataUrl;
    if (downloadLink) {
        downloadLink.href = dataUrl;
        downloadLink.download = `31_Ledger_${Date.now()}.png`;
    }

    if (typeof window.toggleModal === 'function') {
        window.toggleModal('screenshot-modal');
    }
};

window.closeScreenshotModal = function() {
    if (typeof window.toggleModal === 'function') {
        window.toggleModal('screenshot-modal');
    } else {
        const modal = document.getElementById('screenshot-modal');
        if (modal) modal.style.display = 'none';
    }
};
