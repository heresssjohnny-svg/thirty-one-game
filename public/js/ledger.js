// public/js/ledger.js - Client Lifetime Ledger & Bilateral Balance Renderer

window.cachedLifetimeBalances = window.cachedLifetimeBalances || null;

/**
 * Opens the Lifetime Ledger modal from the Main Menu or In-Game HUD.
 */
window.openLifetimeLedgerModal = function() {
    const modal = document.getElementById('lifetime-ledger-modal');
    if (!modal) return;

    modal.style.display = 'flex';

    // Retrieve active username from input, session, or local storage
    const currentUsername = (
        document.getElementById('username-input')?.value ||
        window.clientState?.username ||
        window.userSession?.username ||
        localStorage.getItem('saved_username') ||
        ''
    ).trim();

    // Render cached data immediately if available while fetching fresh records
    if (window.cachedLifetimeBalances) {
        window.renderLifetimeLedger(window.cachedLifetimeBalances);
    } else {
        const container = document.getElementById('lifetime-ledger-table-container');
        if (container) {
            container.innerHTML = '<div class="empty-list-notice" style="color:var(--text-muted); padding:16px; text-align:center;">Loading lifetime balances...</div>';
        }
    }

    // Send WebSocket request for lifetime balances
    const sendPayload = {
        type: 'GET_LIFETIME_LEDGER',
        username: currentUsername
    };

    if (typeof window.sendSocketMessage === 'function') {
        window.sendSocketMessage(sendPayload);
    } else if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(sendPayload);
    } else if (window.network && typeof window.network.send === 'function') {
        window.network.send(sendPayload);
    } else if (window.appGlobals?.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(sendPayload));
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(sendPayload));
    }
};

window.closeLifetimeLedgerModal = function() {
    const modal = document.getElementById('lifetime-ledger-modal');
    if (modal) modal.style.display = 'none';
};

/**
 * Renders SQLite lifetime balances with bilateral net balance formatting.
 */
window.renderLifetimeLedger = function(balances) {
    window.cachedLifetimeBalances = balances;
    const container = document.getElementById('lifetime-ledger-table-container');
    if (!container) return;

    if (!Array.isArray(balances) || balances.length === 0) {
        container.innerHTML = '<div class="empty-list-notice" style="color:var(--text-muted); padding:16px; text-align:center;">No lifetime balance entries found.</div>';
        return;
    }

    const myUsername = (
        document.getElementById('username-input')?.value ||
        window.clientState?.username ||
        window.userSession?.username ||
        localStorage.getItem('saved_username') ||
        ''
    ).trim().toLowerCase();

    let rowsHtml = '';

    balances.forEach(row => {
        const debtor = row.debtor_username || row.debtor || 'Unknown';
        const creditor = row.creditor_username || row.creditor || 'Unknown';
        const amount = Number(row.net_amount || row.amount || 0);
        if (amount <= 0) return;

        const isMeDebtor = debtor.toLowerCase() === myUsername;
        const isMeCreditor = creditor.toLowerCase() === myUsername;

        let statusText = '';
        let badgeStyle = '';

        if (isMeDebtor) {
            statusText = `You owe <b style="color:#4ade80;">${creditor}</b>`;
            badgeStyle = 'color:#f87171;';
        } else if (isMeCreditor) {
            statusText = `<b style="color:#f87171;">${debtor}</b> owes you`;
            badgeStyle = 'color:#4ade80;';
        } else {
            statusText = `<b style="color:#f87171;">${debtor}</b> owes <b style="color:#4ade80;">${creditor}</b>`;
            badgeStyle = 'color:#fde047;';
        }

        const dateStr = row.updated_at ? new Date(row.updated_at).toLocaleDateString() : '';

        rowsHtml += `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; margin-bottom:6px; background:rgba(0,0,0,0.35); border:1px solid rgba(212,175,55,0.25); border-radius:6px;">
                <div>
                    <div style="font-size:0.9rem; color:#f8fafc;">${statusText}</div>
                    ${dateStr ? `<div style="font-size:0.7rem; color:#94a3b8;">Updated: ${dateStr}</div>` : ''}
                </div>
                <div style="font-size:1.1rem; font-weight:800; ${badgeStyle}">
                    $${amount}
                </div>
            </div>
        `;
    });

    container.innerHTML = rowsHtml || '<div class="empty-list-notice" style="color:var(--text-muted); padding:16px; text-align:center;">All debts settled ($0 net balance).</div>';
};

/**
 * Settlement / Credit application helper
 */
window.applyLifetimeCredit = function(debtorId, creditorId, amount) {
    const payload = {
        type: 'APPLY_CREDIT',
        debtorId,
        creditorId,
        amount: Number(amount)
    };

    if (window.appGlobals?.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(payload));
    }
};
