// public/js/ledger.js - Session & Lifetime Ledger Management Engine

/**
 * Calculates bilateral/pairwise net balances from raw ledger debts[span_4](start_span)[span_4](end_span)[span_5](start_span)[span_5](end_span).
 * Positive = player is owed money (creditor)[span_6](start_span)[span_6](end_span)[span_7](start_span)[span_7](end_span).
 * Negative = player owes money (debtor)[span_8](start_span)[span_8](end_span)[span_9](start_span)[span_9](end_span).
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
 * Helper to dispatch WebSocket payloads across client setups
 */
function sendLedgerSocket(payload) {
    if (typeof window.sendSocket === 'function') {
        window.sendSocket(payload);
    } else {
        const ws = window.gameSocket || window.ws || window.socket || window.appGlobals?.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }
}

// -------------------------------------------------------------
// 1. SESSION LEDGER (FILTERED TO "OWES ME" / "I OWE")
// -------------------------------------------------------------

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
        || document.getElementById('session-ledger-list')
        || document.getElementById('session-settled-ledger-list');
    if (!container) return;

    const state = window.clientState || {};
    const lobby = window.appGlobals?.latestLobbySnapshot || {};
    const mainLedger = lobby.mainGameLedger || state.mainGameLedger || {};
    const sideLedger = lobby.sideBetLedger || state.sideBetLedger || {};

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
    const myUsername = (state.username || localStorage.getItem('blitz31_username') || localStorage.getItem('saved_username') || '').toLowerCase();
    const allRows = [];
    const processedPairs = new Set();

    for (const p1 in netMatrix) {
        for (const p2 in netMatrix[p1]) {
            const pairKey = [p1, p2].sort().join(':::');
            if (processedPairs.has(pairKey)) continue;
            processedPairs.add(pairKey);

            const balance = netMatrix[p1][p2];
            if (balance > 0) {
                allRows.push({ debtor: p2, creditor: p1, amount: balance });
            } else if (balance < 0) {
                allRows.push({ debtor: p1, creditor: p2, amount: Math.abs(balance) });
            }
        }
    }

    // FILTER: Only display debts involving the current player
    const myRows = allRows.filter(r => 
        r.debtor.toLowerCase() === myUsername || r.creditor.toLowerCase() === myUsername
    );

    if (myRows.length === 0) {
        container.innerHTML = `
            <div class="ledger-empty-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                No debts involving you. All square!
            </div>
        `;
        return;
    }

    // List of players I currently owe (targets for debt transfer)
    const peopleIOwe = myRows
        .filter(r => r.debtor.toLowerCase() === myUsername)
        .map(r => ({ name: r.creditor, amount: r.amount }));

    let html = '<div class="ledger-rows-list" style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem;">';
    myRows.forEach(r => {
        const isMeDebtor = r.debtor.toLowerCase() === myUsername;
        const isMeCreditor = r.creditor.toLowerCase() === myUsername;

        const debtorStyle = isMeDebtor ? 'color: #f87171; font-weight: bold;' : 'color: #fca5a5;';
        const creditorStyle = isMeCreditor ? 'color: #34d399; font-weight: bold;' : 'color: #86efac;';

        // Transfer button is enabled when someone owes me AND I owe someone else
        const canTransfer = isMeCreditor && peopleIOwe.length > 0;
        const transferBtn = canTransfer ? `
            <button type="button" class="transfer-debt-btn" onclick="openTransferDebtModal('${escapeHtml(r.debtor)}', ${r.amount})" style="background: linear-gradient(135deg, #d97706, #b45309); color: #fff; border: 1px solid #fbbf24; border-radius: 4px; padding: 3px 8px; font-size: 0.75rem; font-weight: 700; cursor: pointer; text-transform: uppercase;">
                Transfer
            </button>
        ` : '';

        html += `
            <div class="ledger-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3); padding: 0.6rem 0.8rem; border-radius: 6px; border-left: 3px solid ${isMeDebtor ? '#ef4444' : '#10b981'};">
                <div style="font-size: 0.9rem;">
                    <span style="${debtorStyle}">${isMeDebtor ? 'You' : escapeHtml(r.debtor)}</span> owes 
                    <span style="${creditorStyle}">${isMeCreditor ? 'You' : escapeHtml(r.creditor)}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.6rem;">
                    <div style="font-weight: bold; color: ${isMeDebtor ? '#f87171' : '#34d399'}; font-size: 1rem;">
                        ${isMeDebtor ? '-' : '+'}$${r.amount.toFixed(2)}
                    </div>
                    ${transferBtn}
                </div>
            </div>
        `;
    });
    html += '</div>';

    container.innerHTML = html;
}

// -------------------------------------------------------------
// 2. SESSION DEBT TRANSFER MODAL
// -------------------------------------------------------------

function ensureTransferModalDOM() {
    let modal = document.getElementById('debt-transfer-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'debt-transfer-modal';
        modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: none; align-items: center; justify-content: center; z-index: 10005; padding: 16px;';
        document.body.appendChild(modal);
    }
    return modal;
}

function openTransferDebtModal(debtorName, maxOwed) {
    const modal = ensureTransferModalDOM();
    const state = window.clientState || {};
    const myUsername = (state.username || localStorage.getItem('blitz31_username') || localStorage.getItem('saved_username') || '').toLowerCase();

    const lobby = window.appGlobals?.latestLobbySnapshot || {};
    const mainLedger = lobby.mainGameLedger || state.mainGameLedger || {};
    const sideLedger = lobby.sideBetLedger || state.sideBetLedger || {};

    const combined = {};
    const merge = (src) => {
        for (const d in src) {
            if (!combined[d]) combined[d] = {};
            for (const c in src[d]) {
                combined[d][c] = (combined[d][c] || 0) + (Number(src[d][c]) || 0);
            }
        }
    };
    merge(mainLedger);
    merge(sideLedger);

    const netMatrix = calculatePairwiseNet(combined);
    const creditors = [];

    if (netMatrix[myUsername]) {
        for (const target in netMatrix[myUsername]) {
            const balance = netMatrix[myUsername][target];
            if (balance < 0) {
                creditors.push({ name: target, amount: Math.abs(balance) });
            }
        }
    }

    if (creditors.length === 0) {
        alert("You do not currently owe anyone money to transfer this debt to.");
        return;
    }

    modal.innerHTML = `
        <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #fbbf24; border-radius: 10px; width: 100%; max-width: 380px; padding: 18px; color: #f8fafc; font-family: inherit; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
            <h3 style="margin: 0 0 8px; color: #fbbf24; font-size: 1.15rem; text-align: center; text-transform: uppercase;">Transfer Debt</h3>
            <p style="margin: 0 0 14px; font-size: 0.85rem; text-align: center; color: #cbd5e1;">
                Transfer <strong style="color: #fca5a5;">${escapeHtml(debtorName)}</strong>'s debt (up to $${maxOwed.toFixed(2)}) to someone you owe.
            </p>

            <div style="display: flex; flex-direction: column; gap: 10px;">
                <div>
                    <label style="font-size: 0.8rem; color: #94a3b8; display: block; margin-bottom: 4px;">Transfer To (Creditor You Owe):</label>
                    <select id="transfer-target-select" style="width: 100%; padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.6); border: 1px solid #34d399; color: #fff; font-size: 0.9rem;">
                        ${creditors.map(c => `<option value="${escapeHtml(c.name)}" data-max="${c.amount}">${escapeHtml(c.name)} (You owe$${c.amount.toFixed(2)})</option>`).join('')}
                    </select>
                </div>

                <div>
                    <label style="font-size: 0.8rem; color: #94a3b8; display: block; margin-bottom: 4px;">Amount to Transfer ($):</label>
                    <input type="number" id="transfer-amount-input" step="0.5" min="0.5" max="${maxOwed}" value="${maxOwed.toFixed(2)}" style="width: 100%; padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.6); border: 1px solid #34d399; color: #fbbf24; font-weight: bold; font-size: 1rem; box-sizing: border-box;" />
                </div>

                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button type="button" onclick="closeTransferDebtModal()" style="flex: 1; padding: 8px; border-radius: 6px; background: #374151; color: #fff; border: none; cursor: pointer; font-weight: bold;">Cancel</button>
                    <button type="button" onclick="confirmDebtTransfer('${escapeHtml(debtorName)}', ${maxOwed})" style="flex: 1; padding: 8px; border-radius: 6px; background: linear-gradient(135deg, #10b981, #059669); color: #fff; border: 1px solid #34d399; cursor: pointer; font-weight: bold;">Confirm</button>
                </div>
            </div>
        </div>
    `;

    modal.style.display = 'flex';
}

function closeTransferDebtModal() {
    const modal = document.getElementById('debt-transfer-modal');
    if (modal) modal.style.display = 'none';
}

function confirmDebtTransfer(debtorName, maxOwed) {
    const targetSelect = document.getElementById('transfer-target-select');
    const amountInput = document.getElementById('transfer-amount-input');
    if (!targetSelect || !amountInput) return;

    const toCreditor = targetSelect.value;
    const amount = parseFloat(amountInput.value);

    if (isNaN(amount) || amount <= 0) {
        alert("Please enter a valid amount.");
        return;
    }

    const maxAllowed = Math.min(maxOwed, parseFloat(targetSelect.selectedOptions[0].dataset.max || maxOwed));
    if (amount > maxAllowed) {
        alert(`Maximum transferable amount is $${maxAllowed.toFixed(2)}.`);
        return;
    }

    sendLedgerSocket({
        type: 'TRANSFER_DEBT',
        fromDebtor: debtorName,
        toCreditor: toCreditor,
        amount: amount,
        code: window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room')
    });

    closeTransferDebtModal();
}

// -------------------------------------------------------------
// 3. CANVAS SNAPSHOT (FILTERED PERSONAL LEDGER)
// -------------------------------------------------------------

async function shareLedgerSnapshot() {
    const state = window.clientState || {};
    const lobby = window.appGlobals?.latestLobbySnapshot || {};
    const mainLedger = lobby.mainGameLedger || state.mainGameLedger || {};
    const sideLedger = lobby.sideBetLedger || state.sideBetLedger || {};

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
                if (p1.toLowerCase() === myUsername || p2.toLowerCase() === myUsername) {
                    rows.push({ debtor: p2, creditor: p1, amount: balance });
                }
            } else if (balance < 0) {
                if (p1.toLowerCase() === myUsername || p2.toLowerCase() === myUsername) {
                    rows.push({ debtor: p1, creditor: p2, amount: Math.abs(balance) });
                }
            }
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
    ctx.fillText('BLITZ 31 - PERSONAL LEDGER', canvas.width / 2, 60);

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
// 4. IDENTITY & LIFETIME RETRIEVAL
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

function requestLifetimeLedger() {
    const ws = window.gameSocket || window.ws || window.socket || window.appGlobals?.ws;
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
            const retryWs = window.gameSocket || window.ws || window.socket || window.appGlobals?.ws;
            if (retryWs && retryWs.readyState === WebSocket.OPEN) {
                retryWs.send(payload);
            }
        }, 300);
    }
}

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

function closeLifetimeLedgerModal() {
    const modal = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    if (modal) modal.style.display = 'none';
}

// -------------------------------------------------------------
// 5. LIFETIME LEDGER RENDERING & TRANSFER
// -------------------------------------------------------------

function renderLifetimeLedger(balances) {
    const modal = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    const container = document.getElementById('lifetime-ledger-table-container')
        || document.getElementById('lifetime-ledger-content') 
        || document.getElementById('lifetime-ledger-list')
        || (modal ? modal.querySelector('.ledger-content') : null);

    if (!container) return;

    window.cachedLifetimeBalancesList = Array.isArray(balances) ? balances : [];
    const activeRows = window.cachedLifetimeBalancesList.filter(b => Math.abs(Number(b.net) || 0) > 0.01);

    if (activeRows.length === 0) {
        container.innerHTML = `
            <div class="ledger-empty-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                All debts settled ($0 net balance).
            </div>
        `;
        return;
    }

    const peopleIOweLifetime = activeRows.filter(b => Number(b.net) < -0.01);
    let html = '<div class="lifetime-ledger-rows" style="display: flex; flex-direction: column; gap: 0.65rem; margin-top: 0.5rem;">';

    activeRows.forEach(row => {
        const net = Number(row.net) || 0;
        const otherName = escapeHtml(row.username || 'Player');
        const rawNameAttr = (row.username || 'Player').replace(/'/g, "\\'");

        if (net > 0) {
            // Other player owes current player
            const canTransfer = peopleIOweLifetime.length > 0;
            const transferBtn = canTransfer ? `
                <button type="button" class="transfer-lifetime-btn" onclick="openLifetimeTransferModal('${row.other_id}', '${rawNameAttr}', ${net})" style="background: linear-gradient(135deg, #d97706 0%, #b45309 100%); color: #ffffff; border: 1px solid #fbbf24; border-radius: 4px; padding: 4px 9px; font-size: 0.76rem; font-weight: 700; cursor: pointer; text-transform: uppercase;">
                    Transfer
                </button>
            ` : '';

            html += `
                <div class="lifetime-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.35); padding: 0.75rem 0.9rem; border-radius: 6px; border-left: 3px solid #10b981; flex-wrap: wrap; gap: 0.5rem;">
                    <div style="font-size: 0.92rem;">
                        <span style="color: #fca5a5; font-weight: 600;">${otherName}</span> owes 
                        <span style="color: #34d399; font-weight: 700;">You</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-weight: 700; color: #34d399; font-size: 1.05rem;">
                            +$${net.toFixed(2)}
                        </span>
                        ${transferBtn}
                        <button type="button" class="credit-action-btn" onclick="openCreditDialog('${row.other_id}', '${rawNameAttr}', ${net})" style="background: linear-gradient(135deg, #059669 0%, #047857 100%); color: #ffffff; border: 1px solid #34d399; border-radius: 4px; padding: 4px 9px; font-size: 0.76rem; font-weight: 700; cursor: pointer; text-transform: uppercase;">
                            Credit
                        </button>
                    </div>
                </div>
            `;
        } else {
            // Current player owes other player
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

function ensureLifetimeTransferModalDOM() {
    let modal = document.getElementById('lifetime-debt-transfer-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'lifetime-debt-transfer-modal';
        modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: none; align-items: center; justify-content: center; z-index: 10006; padding: 16px;';
        document.body.appendChild(modal);
    }
    return modal;
}

function openLifetimeTransferModal(debtorId, debtorName, maxAmount) {
    const modal = ensureLifetimeTransferModalDOM();
    const creditors = (window.cachedLifetimeBalancesList || [])
        .filter(b => Number(b.net) < -0.01)
        .map(b => ({ id: b.other_id, name: b.username, amount: Math.abs(Number(b.net)) }));

    if (creditors.length === 0) {
        alert("You do not currently owe anyone money in your lifetime records to transfer this to.");
        return;
    }

    modal.innerHTML = `
        <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #fbbf24; border-radius: 10px; width: 100%; max-width: 380px; padding: 18px; color: #f8fafc; font-family: inherit; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
            <h3 style="margin: 0 0 8px; color: #fbbf24; font-size: 1.15rem; text-align: center; text-transform: uppercase;">Transfer Lifetime Debt</h3>
            <p style="margin: 0 0 14px; font-size: 0.85rem; text-align: center; color: #cbd5e1;">
                Transfer <strong style="color: #fca5a5;">${escapeHtml(debtorName)}</strong>'s debt (up to $${maxAmount.toFixed(2)}) to someone you owe.
            </p>

            <div style="display: flex; flex-direction: column; gap: 10px;">
                <div>
                    <label style="font-size: 0.8rem; color: #94a3b8; display: block; margin-bottom: 4px;">Transfer To (Creditor You Owe):</label>
                    <select id="lifetime-transfer-target" style="width: 100%; padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.6); border: 1px solid #34d399; color: #fff; font-size: 0.9rem;">
                        ${creditors.map(c => `<option value="${c.id}" data-max="${c.amount}">${escapeHtml(c.name)} (You owe$${c.amount.toFixed(2)})</option>`).join('')}
                    </select>
                </div>

                <div>
                    <label style="font-size: 0.8rem; color: #94a3b8; display: block; margin-bottom: 4px;">Amount to Transfer ($):</label>
                    <input type="number" id="lifetime-transfer-amount" step="0.5" min="0.5" max="${maxAmount}" value="${maxAmount.toFixed(2)}" style="width: 100%; padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.6); border: 1px solid #34d399; color: #fbbf24; font-weight: bold; font-size: 1rem; box-sizing: border-box;" />
                </div>

                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button type="button" onclick="document.getElementById('lifetime-debt-transfer-modal').style.display='none'" style="flex: 1; padding: 8px; border-radius: 6px; background: #374151; color: #fff; border: none; cursor: pointer; font-weight: bold;">Cancel</button>
                    <button type="button" onclick="confirmLifetimeDebtTransfer('${debtorId}', ${maxAmount})" style="flex: 1; padding: 8px; border-radius: 6px; background: linear-gradient(135deg, #10b981, #059669); color: #fff; border: 1px solid #34d399; cursor: pointer; font-weight: bold;">Confirm</button>
                </div>
            </div>
        </div>
    `;

    modal.style.display = 'flex';
}

function confirmLifetimeDebtTransfer(debtorId, maxOwed) {
    const targetSelect = document.getElementById('lifetime-transfer-target');
    const amountInput = document.getElementById('lifetime-transfer-amount');
    if (!targetSelect || !amountInput) return;

    const toCreditorId = targetSelect.value;
    const amount = parseFloat(amountInput.value);

    if (isNaN(amount) || amount <= 0) {
        alert("Please enter a valid amount.");
        return;
    }

    const maxAllowed = Math.min(maxOwed, parseFloat(targetSelect.selectedOptions[0].dataset.max || maxOwed));
    if (amount > maxAllowed) {
        alert(`Maximum transferable amount is $${maxAllowed.toFixed(2)}.`);
        return;
    }

    const token = localStorage.getItem('31_jwt') || localStorage.getItem('token') || localStorage.getItem('auth_token');
    const myId = getCurrentUserId();

    sendLedgerSocket({
        type: 'TRANSFER_LIFETIME_DEBT',
        fromDebtorId: debtorId,
        toCreditorId: toCreditorId,
        myId: myId,
        amount: amount,
        token: token || null
    });

    document.getElementById('lifetime-debt-transfer-modal').style.display = 'none';
}

// -------------------------------------------------------------
// 6. CREDIT / SETTLEMENT ENGINE
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

function applySettlementCredit(otherUserId, amount) {
    const token = localStorage.getItem('31_jwt') || localStorage.getItem('token') || localStorage.getItem('auth_token');
    const myId = getCurrentUserId();
    const cleanAmount = Number(amount);
    if (!cleanAmount || cleanAmount <= 0) return;

    sendLedgerSocket({
        type: 'APPLY_CREDIT',
        debtorId: myId,
        creditorId: otherUserId,
        amount: cleanAmount,
        token: token || null
    });

    const container = document.getElementById('lifetime-ledger-table-container');
    if (container) {
        container.innerHTML = `
            <div class="ledger-loading-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                Applying credit of $${cleanAmount.toFixed(2)}...
            </div>
        `;
    }
}

// -------------------------------------------------------------
// 7. UTILITIES & GLOBAL EXPORTS
// -------------------------------------------------------------

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

window.calculatePairwiseNet = calculatePairwiseNet;
window.openSessionLedgerModal = openSessionLedgerModal;
window.closeSessionLedgerModal = closeSessionLedgerModal;
window.renderSessionLedger = renderSessionLedger;
window.openTransferDebtModal = openTransferDebtModal;
window.closeTransferDebtModal = closeTransferDebtModal;
window.confirmDebtTransfer = confirmDebtTransfer;
window.shareLedgerSnapshot = shareLedgerSnapshot;
window.requestLifetimeLedger = requestLifetimeLedger;
window.openLifetimeLedgerModal = openLifetimeLedgerModal;
window.closeLifetimeLedgerModal = closeLifetimeLedgerModal;
window.renderLifetimeLedger = renderLifetimeLedger;
window.handleLifetimeLedgerData = renderLifetimeLedger;
window.openLifetimeTransferModal = openLifetimeTransferModal;
window.confirmLifetimeDebtTransfer = confirmLifetimeDebtTransfer;
window.openCreditDialog = openCreditDialog;
window.closeCreditDialog = closeCreditDialog;
window.applySettlementCredit = applySettlementCredit;
window.escapeHtml = escapeHtml;
