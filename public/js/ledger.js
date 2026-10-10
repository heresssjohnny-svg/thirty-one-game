// public/js/ledger.js - Session & Lifetime Ledger Management Engine

/**
 * Calculates bilateral/pairwise net balances from raw ledger debts.
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
    const modal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (!modal) return;

    renderSessionLedger();
    modal.style.display = 'flex';
}

function closeSessionLedgerModal() {
    const modal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (modal) modal.style.display = 'none';
}

function renderSessionLedger() {
    const container = document.getElementById('session-ledger-content') 
        || document.getElementById('ledger-content')
        || document.getElementById('session-ledger-list');
    if (!container) return;

    const state = window.clientState || {};
    const mainLedger = state.mainGameLedger || {};
    const sideLedger = state.sideBetLedger || {};

    const combined = {};
    const mergeLedger = (src) => {
        for (const debtor in src) {
            if (!combined[debtor]) combined[debtor] = {};
            for (const creditor in src[debtor]) {
                const amt = Number(src[debtor][creditor]) || 0;
                combined[debtor][creditor] = (combined[debtor][creditor] || 0) + amt;
            }
        }
    };

    mergeLedger(mainLedger);
    mergeLedger(sideLedger);

    const netMatrix = calculatePairwiseNet(combined);
    const myUsername = (state.username || '').toLowerCase();
    const rows = [];
    const processedPairs = new Set();

    for (const p1 in netMatrix) {
        for (const p2 in netMatrix[p1]) {
            const pairKey = [p1, p2].sort().join(':::');
            if (processedPairs.has(pairKey)) continue;
            processedPairs.add(pairKey);

            const balance = netMatrix[p1][p2];
            if (balance > 0) {
                rows.push({ debtor: p2, creditor: p1, amount: balance });
            } else if (balance < 0) {
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

        const debtorStyle = isMeDebtor ? 'color: #f87171; font-weight: bold;' : 'color: #fca5a5;';
        const creditorStyle = isMeCreditor ? 'color: #34d399; font-weight: bold;' : 'color: #86efac;';

        html += `
            <div class="ledger-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3); padding: 0.6rem 0.8rem; border-radius: 6px; border-left: 3px solid #10b981;">
                <div style="font-size: 0.9rem;">
                    <span style="${debtorStyle}">${escapeHtml(r.debtor)}</span> owes 
                    <span style="${creditorStyle}">${escapeHtml(r.creditor)}</span>
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
    const mergeLedger = (src) => {
        for (const debtor in src) {
            if (!combined[debtor]) combined[debtor] = {};
            for (const creditor in src[debtor]) {
                const amt = Number(src[debtor][creditor]) || 0;
                combined[debtor][creditor] = (combined[debtor][creditor] || 0) + amt;
            }
        }
    };
    mergeLedger(mainLedger);
    mergeLedger(sideLedger);

    const netMatrix = calculatePairwiseNet(combined);
    const rows = [];
    const processedPairs = new Set();

    for (const p1 in netMatrix) {
        for (const p2 in netMatrix[p1]) {
            const pairKey = [p1, p2].sort().join(':::');
            if (processedPairs.has(pairKey)) continue;
            processedPairs.add(pairKey);

            const balance = netMatrix[p1][p2];
            if (balance > 0) rows.push({ debtor: p2, creditor: p1, amount: balance });
            else if (balance < 0) rows.push({ debtor: p1, creditor: p2, amount: Math.abs(balance) });
        }
    }

    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 300 + (Math.max(rows.length, 1) * 45);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#064e3b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

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

// -------------------------------------------------------------
// IDENTITY & JWT HELPER
// -------------------------------------------------------------
function getCurrentUserId() {
    try {
        const token = localStorage.getItem('31_jwt') || localStorage.getItem('token') || localStorage.getItem('auth_token');
        if (token) {
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.id || payload.userId || null;
        }
    } catch (e) {}

    return (window.clientState && (window.clientState.userId || window.clientState.id))
        || (window.userSession && (window.userSession.id || window.userSession.userId))
        || localStorage.getItem('blitz31_user_id')
        || null;
}

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

    const container = document.getElementById('lifetime-ledger-table-container') 
        || document.getElementById('lifetime-ledger-content') 
        || document.getElementById('lifetime-ledger-list')
        || (modal.querySelector ? modal.querySelector('.ledger-content') : null);

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
 * Adds a Credit / Settle action button when other players owe the current user.
 * @param {Array<{ other_id: string, username: string, net: number }>} balances
 */
function renderLifetimeLedger(balances) {
    const modal = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    const container = document.getElementById('lifetime-ledger-table-container')
        || document.getElementById('lifetime-ledger-content') 
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

    let html = '<div class="lifetime-ledger-rows" style="display: flex; flex-direction: column; gap: 0.65rem; margin-top: 0.5rem;">';

    activeRows.forEach(row => {
        const net = Number(row.net) || 0;
        const otherName = escapeHtml(row.username || 'Player');
        const rawNameAttr = (row.username || 'Player').replace(/'/g, "\\'");

        if (net > 0) {
            // Other user owes current user (Creditor view -> can credit/settle)
            html += `
                <div class="lifetime-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.35); padding: 0.75rem 0.9rem; border-radius: 6px; border-left: 3px solid #10b981; flex-wrap: wrap; gap: 0.5rem;">
                    <div style="font-size: 0.92rem;">
                        <span style="color: #fca5a5; font-weight: 600;">${otherName}</span> owes 
                        <span style="color: #34d399; font-weight: 700;">You</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.65rem;">
                        <span style="font-weight: 700; color: #34d399; font-size: 1.05rem;">
                            +$${net.toFixed(2)}
                        </span>
                        <button type="button" class="credit-action-btn" onclick="openCreditDialog('${row.other_id}', '${rawNameAttr}', ${net})" style="background: linear-gradient(135deg, #059669 0%, #047857 100%); color: #ffffff; border: 1px solid #34d399; border-radius: 4px; padding: 4px 9px; font-size: 0.76rem; font-weight: 700; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                            Credit
                        </button>
                    </div>
                </div>
            `;
        } else {
            // Current user owes other user (Debtor view)
            html += `
                <div class="lifetime-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.35); padding: 0.75rem 0.9rem; border-radius: 6px; border-left: 3px solid #ef4444; flex-wrap: wrap; gap: 0.5rem;">
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

// -------------------------------------------------------------
// CREDIT & SETTLEMENT DIALOG ENGINE
// -------------------------------------------------------------
let activeCreditTarget = null;

function ensureCreditModalDOM() {
    let modal = document.getElementById('credit-settle-dialog');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'credit-settle-dialog';
        modal.style.cssText = `
            position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75);
            display: none; align-items: center; justify-content: center;
            z-index: 10000; padding: 16px;
        `;
        modal.innerHTML = `
            <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #d97706; border-radius: 10px; width: 100%; max-width: 360px; padding: 18px; box-shadow: 0 8px 30px rgba(0,0,0,0.8); color: #f8fafc; font-family: inherit;">
                <h3 style="margin: 0 0 6px; color: #fbbf24; font-size: 1.15rem; text-align: center; text-transform: uppercase;">Apply Credit / Settle</h3>
                <p id="credit-dialog-subtitle" style="margin: 0 0 14px; font-size: 0.88rem; text-align: center; color: #cbd5e1;"></p>
                
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <label style="font-size: 0.78rem; color: #94a3b8; text-transform: uppercase; font-weight: 600;">Credit Amount ($)</label>
                        <input id="credit-dialog-amount" type="number" step="0.5" min="0.5" style="background: #020a06; border: 1.5px solid #d97706; border-radius: 5px; color: #fff; padding: 8px 10px; font-size: 1.05rem; font-weight: bold; outline: none; width: 100%; box-sizing: border-box;" />
                    </div>

                    <div style="display: flex; gap: 6px;">
                        <button type="button" id="credit-dialog-full-btn" style="flex: 1; background: rgba(217, 119, 6, 0.2); border: 1px solid #d97706; color: #fbbf24; border-radius: 4px; padding: 6px; font-size: 0.8rem; font-weight: 700; cursor: pointer;">
                            Settle In Full
                        </button>
                    </div>

                    <div style="display: flex; gap: 8px; margin-top: 6px;">
                        <button type="button" onclick="closeCreditDialog()" style="flex: 1; background: #334155; color: #e2e8f0; border: none; border-radius: 5px; padding: 9px; font-size: 0.85rem; font-weight: 700; cursor: pointer;">
                            Cancel
                        </button>
                        <button type="button" id="credit-dialog-confirm-btn" style="flex: 1; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; border: 1px solid #34d399; border-radius: 5px; padding: 9px; font-size: 0.85rem; font-weight: 700; cursor: pointer;">
                            Confirm
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    return modal;
}

function openCreditDialog(debtorId, debtorName, maxAmount) {
    const modal = ensureCreditModalDOM();
    activeCreditTarget = { debtorId, debtorName, maxAmount };

    const subtitle = document.getElementById('credit-dialog-subtitle');
    const input = document.getElementById('credit-dialog-amount');
    const fullBtn = document.getElementById('credit-dialog-full-btn');
    const confirmBtn = document.getElementById('credit-dialog-confirm-btn');

    if (subtitle) {
        subtitle.innerHTML = `Credit debt owed by <b style="color: #fca5a5;">${escapeHtml(debtorName)}</b> (Max: $${maxAmount.toFixed(2)})`;
    }
    if (input) {
        input.value = maxAmount.toFixed(2);
        input.max = maxAmount;
    }
    if (fullBtn) {
        fullBtn.onclick = () => {
            if (input) input.value = maxAmount.toFixed(2);
        };
    }
    if (confirmBtn) {
        confirmBtn.onclick = () => {
            const entered = Number(input.value);
            if (!entered || entered <= 0) {
                alert('Please enter a valid credit amount.');
                return;
            }
            if (entered > maxAmount) {
                alert(`Credit amount cannot exceed total debt owed ($${maxAmount.toFixed(2)}).`);
                return;
            }
            applySettlementCredit(debtorId, entered);
            closeCreditDialog();
        };
    }

    modal.style.display = 'flex';
}

function closeCreditDialog() {
    const modal = document.getElementById('credit-settle-dialog');
    if (modal) modal.style.display = 'none';
    activeCreditTarget = null;
}

/**
 * Sends an APPLY_CREDIT packet over WebSocket to offset pairwise SQLite debt.
 */
function applySettlementCredit(otherUserId, amount) {
    const ws = window.gameSocket || window.ws || window.socket;
    const token = localStorage.getItem('31_jwt') || localStorage.getItem('token') || localStorage.getItem('auth_token');
    const myId = getCurrentUserId();

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert('Server connection lost. Please refresh the page and try again.');
        return;
    }

    const cleanAmount = Number(amount);
    if (!cleanAmount || cleanAmount <= 0) return;

    // In bilateral netting: current user (creditor) records an offsetting debt entry
    // to credit the debtor's balance down to zero or reduced principal
    ws.send(JSON.stringify({
        type: 'APPLY_CREDIT',
        debtorId: myId,
        creditorId: otherUserId,
        amount: cleanAmount,
        token: token || null
    }));

    // Briefly display loading status in container
    const container = document.getElementById('lifetime-ledger-table-container');
    if (container) {
        container.innerHTML = `
            <div class="ledger-loading-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                Applying credit of $${cleanAmount.toFixed(2)}...
            </div>
        `;
    }
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
window.openCreditDialog = openCreditDialog;
window.closeCreditDialog = closeCreditDialog;
window.applySettlementCredit = applySettlementCredit;
window.escapeHtml = escapeHtml;
