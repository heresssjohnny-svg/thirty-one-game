// public/js/ledger.js - Session & Lifetime Ledger Engine (PART 1 OF 2)

/**
 * Calculates bilateral/pairwise net balances from raw transactions.
 * Positive = player is owed money (creditor).
 * Negative = player owes money (debtor).
 */
function calculatePairwiseNet(ledger) {
    if (!ledger) return {};
    const net = {};

    for (const debtor in ledger) {
        if (!net[debtor]) net[debtor] = {};
        for (const creditor in ledger[debtor]) {
            if (!net[creditor]) net[creditor] = {};
            const amt = Number(ledger[debtor][creditor]) || 0;
            net[debtor][creditor] = (net[debtor][creditor] || 0) - amt;
            net[creditor][debtor] = (net[creditor][debtor] || 0) + amt;
        }
    }

    return net;
}

/**
 * Renders the in-game Lobby Session Ledger modal
 */
function openSessionLedgerModal() {
    const modal = document.getElementById('ledger-modal') || document.getElementById('session-ledger-modal');
    if (!modal) return;

    renderSessionLedger();
    modal.style.display = 'flex';
}

function closeSessionLedgerModal() {
    const modal = document.getElementById('ledger-modal') || document.getElementById('session-ledger-modal');
    if (modal) modal.style.display = 'none';
}

function renderSessionLedger() {
    const container = document.getElementById('session-ledger-content') || document.getElementById('ledger-content');
    if (!container) return;

    const state = window.clientState || {};
    const mainLedger = state.mainGameLedger || {};
    const sideLedger = state.sideBetLedger || {};

    // Combine session debts
    const combined = {};
    const mergeIntoCombined = (src) => {
        for (const debtor in src) {
            if (!combined[debtor]) combined[debtor] = {};
            for (const creditor in src[debtor]) {
                const amt = Number(src[debtor][creditor]) || 0;
                combined[debtor][creditor] = (combined[debtor][creditor] || 0) + amt;
            }
        }
    };

    mergeIntoCombined(mainLedger);
    mergeIntoCombined(sideLedger);

    const netMatrix = calculatePairwiseNet(combined);
    const myUsername = (state.username || '').toLowerCase();
    const rows = [];
    const processedPairs = new Set();

    for (const p1 in netMatrix) {
        for (const p2 in netMatrix[p1]) {
            const key = [p1, p2].sort().join(':::');
            if (processedPairs.has(key)) continue;
            processedPairs.add(key);

            const balance = netMatrix[p1][p2];
            if (balance > 0) {
                // p2 owes p1
                rows.push({ debtor: p2, creditor: p1, amount: balance });
            } else if (balance < 0) {
                // p1 owes p2
                rows.push({ debtor: p1, creditor: p2, amount: Math.abs(balance) });
            }
        }
    }

    if (rows.length === 0) {
        container.innerHTML = `
            <div class="ledger-empty-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                No active session debts. All square!
            </div>
        `;
        return;
    }

    let html = '<div class="ledger-rows-list" style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem;">';
    rows.forEach(r => {
        const isMeDebtor = r.debtor.toLowerCase() === myUsername;
        const isMeCreditor = r.creditor.toLowerCase() === myUsername;

        const debtorClass = isMeDebtor ? 'color: #f87171; font-weight: bold;' : 'color: #fca5a5;';
        const creditorClass = isMeCreditor ? 'color: #34d399; font-weight: bold;' : 'color: #86efac;';

        html += `
            <div class="ledger-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3); padding: 0.6rem 0.8rem; border-radius: 6px; border-left: 3px solid #10b981;">
                <div style="font-size: 0.9rem;">
                    <span style="${debtorClass}">${escapeHtml(r.debtor)}</span> owes 
                    <span style="${creditorClass}">${escapeHtml(r.creditor)}</span>
                </div>
                <div style="font-weight: bold; color: #fbbf24; font-size: 1rem;">
                    $${r.amount.toFixed(2)}
                </div>
            </div>
        `;
    });
    html += '</div>';

    container.innerHTML = html;
}

/**
 * HTML5 Canvas Exporter for sharing session ledgers
 */
async function shareLedgerSnapshot() {
    const state = window.clientState || {};
    const mainLedger = state.mainGameLedger || {};
    const sideLedger = state.sideBetLedger || {};

    const combined = {};
    const mergeIntoCombined = (src) => {
        for (const debtor in src) {
            if (!combined[debtor]) combined[debtor] = {};
            for (const creditor in src[debtor]) {
                const amt = Number(src[debtor][creditor]) || 0;
                combined[debtor][creditor] = (combined[debtor][creditor] || 0) + amt;
            }
        }
    };
    mergeIntoCombined(mainLedger);
    mergeIntoCombined(sideLedger);

    const netMatrix = calculatePairwiseNet(combined);
    const rows = [];
    const processedPairs = new Set();

    for (const p1 in netMatrix) {
        for (const p2 in netMatrix[p1]) {
            const key = [p1, p2].sort().join(':::');
            if (processedPairs.has(key)) continue;
            processedPairs.add(key);

            const balance = netMatrix[p1][p2];
            if (balance > 0) rows.push({ debtor: p2, creditor: p1, amount: balance });
            else if (balance < 0) rows.push({ debtor: p1, creditor: p2, amount: Math.abs(balance) });
        }
    }

    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 300 + (Math.max(rows.length, 1) * 45);
    const ctx = canvas.getContext('2d');

    // Canvas background
    ctx.fillStyle = '#064e3b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

    // Header
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BLITZ 31 - SESSION LEDGER', canvas.width / 2, 60);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px sans-serif';
    ctx.fillText(new Date().toLocaleString(), canvas.width / 2, 90);

    let y = 140;
    if (rows.length === 0) {
        ctx.fillStyle = '#a7f3d0';
        ctx.font = '18px sans-serif';
        ctx.fillText('All debts settled ($0 net balance)', canvas.width / 2, y + 40);
    } else {
        rows.forEach(r => {
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.fillRect(30, y - 25, canvas.width - 60, 36);

            ctx.font = '16px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillStyle = '#fca5a5';
            ctx.fillText(r.debtor, 45, y);

            ctx.fillStyle = '#ffffff';
            ctx.fillText(' owes ', 45 + ctx.measureText(r.debtor).width, y);

            const owesWidth = ctx.measureText(' owes ').width;
            ctx.fillStyle = '#86efac';
            ctx.fillText(r.creditor, 45 + ctx.measureText(r.debtor).width + owesWidth, y);

            ctx.textAlign = 'right';
            ctx.fillStyle = '#fbbf24';
            ctx.font = 'bold 18px sans-serif';
            ctx.fillText(`$${r.amount.toFixed(2)}`, canvas.width - 45, y);

            y += 45;
        });
    }

    try {
        canvas.toBlob(async (blob) => {
            if (!blob) return;
            const file = new File([blob], 'blitz31-ledger.png', { type: 'image/png' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title: 'Blitz 31 Ledger',
                    text: 'Session settlement balances from Blitz 31',
                    files: [file]
                });
            } else {
                const link = document.createElement('a');
                link.download = 'blitz31-ledger.png';
                link.href = canvas.toDataURL();
                link.click();
            }
        });
    } catch (err) {
        console.error('Snapshot export failed:', err);
    }
}
// public/js/ledger.js - PART 2 OF 2

// -------------------------------------------------------------
// LIFETIME LEDGER DISPATCH & RENDERING
// -------------------------------------------------------------

/**
 * Requests lifetime ledger balances from the server over WebSocket.
 * Passes stored JWT tokens and username as resilient identity fallbacks.
 */
function requestLifetimeLedger() {
    const ws = window.gameSocket || window.ws || window.socket;
    const token = localStorage.getItem('31_jwt') || localStorage.getItem('token') || localStorage.getItem('auth_token');
    const savedUser = localStorage.getItem('blitz31_username') || localStorage.getItem('saved_username');
    const badgeElem = document.getElementById('menu-user-badge') || document.getElementById('user-display-name');
    const username = (window.clientState && window.clientState.username) 
        || savedUser 
        || (badgeElem ? badgeElem.textContent.trim() : null);

    const payload = JSON.stringify({
        type: 'GET_LIFETIME_LEDGER',
        token: token || null,
        username: username || null
    });

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
    } else {
        // Retry shortly if the socket is still handshaking
        setTimeout(() => {
            const retryWs = window.gameSocket || window.ws || window.socket;
            if (retryWs && retryWs.readyState === WebSocket.OPEN) {
                retryWs.send(payload);
            }
        }, 300);
    }
}

/**
 * Opens the Lifetime Ledger modal and initiates balance retrieval.
 */
function openLifetimeLedgerModal() {
    const modal = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    if (!modal) return;

    // Show initial loading state if container is present
    const container = document.getElementById('lifetime-ledger-content') 
        || document.getElementById('lifetime-ledger-list')
        || modal.querySelector('.ledger-content');

    if (container) {
        container.innerHTML = `
            <div class="ledger-loading-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                Fetching lifetime balances from database...
            </div>
        `;
    }

    requestLifetimeLedger();
    modal.style.display = 'flex';
}

/**
 * Closes the Lifetime Ledger modal.
 */
function closeLifetimeLedgerModal() {
    const modal = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * Renders the Lifetime Ledger data received from the backend.
 * @param {Array<{ other_id: string, username: string, net: number }>} balances
 */
function renderLifetimeLedger(balances) {
    const modal = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    const container = document.getElementById('lifetime-ledger-content') 
        || document.getElementById('lifetime-ledger-list')
        || (modal ? modal.querySelector('.ledger-content') : null);

    if (!container) return;

    const activeRows = (Array.isArray(balances) ? balances : []).filter(b => Math.abs(Number(b.net) || 0) > 0.01);

    if (activeRows.length === 0) {
        container.innerHTML = `
            <div class="ledger-empty-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                All debts settled ($0 net balance).
            </div>
        `;
        return;
    }

    let html = '<div class="lifetime-ledger-rows" style="display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.5rem;">';

    activeRows.forEach(row => {
        const net = Number(row.net) || 0;
        const otherName = escapeHtml(row.username || 'Player');

        if (net > 0) {
            // Other user owes current user (Creditor perspective)
            html += `
                <div class="lifetime-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.35); padding: 0.7rem 0.9rem; border-radius: 6px; border-left: 3px solid #10b981;">
                    <div style="font-size: 0.92rem;">
                        <span style="color: #fca5a5; font-weight: 600;">${otherName}</span> owes 
                        <span style="color: #34d399; font-weight: 700;">You</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <span style="font-weight: 700; color: #34d399; font-size: 1.05rem;">
                            +$${net.toFixed(2)}
                        </span>
                    </div>
                </div>
            `;
        } else {
            // Current user owes other user (Debtor perspective)
            html += `
                <div class="lifetime-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.35); padding: 0.7rem 0.9rem; border-radius: 6px; border-left: 3px solid #ef4444;">
                    <div style="font-size: 0.92rem;">
                        <span style="color: #f87171; font-weight: 700;">You</span> owe 
                        <span style="color: #86efac; font-weight: 600;">${otherName}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <span style="font-weight: 700; color: #f87171; font-size: 1.05rem;">
                            -$${Math.abs(net).toFixed(2)}
                        </span>
                    </div>
                </div>
            `;
        }
    });

    html += '</div>';
    container.innerHTML = html;
}

/**
 * Sends a settlement credit to clear bilateral balances in SQLite.
 */
function applySettlementCredit(debtorId, creditorId, amount) {
    const ws = window.gameSocket || window.ws || window.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
        type: 'APPLY_CREDIT',
        debtorId,
        creditorId,
        amount: Number(amount)
    }));
}

/**
 * String safety escaping helper to prevent XSS in dynamic usernames.
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// -------------------------------------------------------------
// GLOBAL EXPORTS & WINDOW HOOKS
// -------------------------------------------------------------
window.calculatePairwiseNet = calculatePairwiseNet;
window.openSessionLedgerModal = openSessionLedgerModal;
window.closeSessionLedgerModal = closeSessionLedgerModal;
window.renderSessionLedger = renderSessionLedger;
window.shareLedgerSnapshot = shareLedgerSnapshot;
window.requestLifetimeLedger = requestLifetimeLedger;
window.openLifetimeLedgerModal = openLifetimeLedgerModal;
window.closeLifetimeLedgerModal = closeLifetimeLedgerModal;
window.renderLifetimeLedger = renderLifetimeLedger;
window.handleLifetimeLedgerData = renderLifetimeLedger;
window.applySettlementCredit = applySettlementCredit;
window.escapeHtml = escapeHtml;
