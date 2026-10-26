// public/js/ledger.js - Bilateral Debt Netting, Session & Lifetime Ledgers, Tab Switcher, Credit, Mark Paid & Debt Transfer

function sendLedgerSocket(payload) {
    if (!payload.code) {
        const activeCode = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room');
        if (activeCode) payload.code = activeCode;
    }
    if (typeof window.initSocketAndSend === 'function') {
        window.initSocketAndSend(payload);
    } else if (typeof window.sendSocketMessage === 'function') {
        window.sendSocketMessage(payload);
    } else if (window.appGlobals?.ws && window.appGlobals.ws.readyState === WebSocket.OPEN) {
        window.appGlobals.ws.send(JSON.stringify(payload));
    } else if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send(JSON.stringify(payload));
    }
}

function resolveMyUsername() {
    const lobby = window.appGlobals?.latestLobbySnapshot;
    if (typeof window.getMyUsername === 'function') {
        const resolved = window.getMyUsername(lobby);
        if (resolved) return resolved;
    }
    const inputVal = document.getElementById('username-input')?.value?.trim();
    if (inputVal) return inputVal;
    if (window.clientState?.username) return window.clientState.username.trim();
    if (window.userSession?.username) return window.userSession.username.trim();
    return (localStorage.getItem('saved_username') || localStorage.getItem('p31_username') || '').trim();
}

// -------------------------------------------------------------
// 0. SESSION <-> LIFETIME LEDGER TAB SWITCHER
// -------------------------------------------------------------
function buildLedgerSwitcherBarHTML(activeTab) {
    const isSession = (activeTab === 'session');
    return `
        <div style="display: flex; gap: 6px; margin-bottom: 12px; background: rgba(0,0,0,0.4); padding: 4px; border-radius: 8px; border: 1px solid rgba(251,191,36,0.3);">
            <button type="button" onclick="window.switchLedgerTab('session')" style="
                flex: 1;
                padding: 8px 10px;
                border-radius: 6px;
                border: none;
                font-weight: 800;
                font-size: 0.8rem;
                cursor: pointer;
                background: ${isSession ? 'linear-gradient(135deg, #d97706, #b45309)' : 'transparent'};
                color: ${isSession ? '#ffffff' : '#94a3b8'};
            ">📋 Session Ledger</button>
            <button type="button" onclick="window.switchLedgerTab('lifetime')" style="
                flex: 1;
                padding: 8px 10px;
                border-radius: 6px;
                border: none;
                font-weight: 800;
                font-size: 0.8rem;
                cursor: pointer;
                background: ${!isSession ? 'linear-gradient(135deg, #d97706, #b45309)' : 'transparent'};
                color: ${!isSession ? '#ffffff' : '#94a3b8'};
            ">📊 Lifetime Ledger</button>
        </div>
    `;
}

window.switchLedgerTab = function(targetTab) {
    const sessionModal = document.getElementById('session-ledger-modal');
    const lifetimeModal = document.getElementById('lifetime-ledger-modal');

    if (targetTab === 'lifetime') {
        if (sessionModal) {
            sessionModal.style.display = 'none';
            sessionModal.classList.add('hidden');
        }
        if (lifetimeModal) {
            lifetimeModal.style.display = 'flex';
            lifetimeModal.classList.remove('hidden');
        }
        renderLifetimeLedger(cachedLifetimeRows);
        requestLifetimeLedger();
    } else {
        if (lifetimeModal) {
            lifetimeModal.style.display = 'none';
            lifetimeModal.classList.add('hidden');
        }
        if (sessionModal) {
            sessionModal.style.display = 'flex';
            sessionModal.classList.remove('hidden');
        }
        renderSessionLedger();
    }
};

// -------------------------------------------------------------
// 1. BILATERAL DEBT NETTING ENGINE (CASE-INSENSITIVE)
// -------------------------------------------------------------
function calculatePairwiseNet(ledger) {
    const net = {};
    if (!ledger || typeof ledger !== 'object') return net;

    const canonicalMap = {};
    const rememberName = (name) => {
        if (!name) return null;
        const clean = String(name).trim();
        if (!clean) return null;
        const lower = clean.toLowerCase();
        if (!canonicalMap[lower]) canonicalMap[lower] = clean;
        return canonicalMap[lower];
    };

    const normalizedLedger = {};
    for (const d in ledger) {
        const dCanon = rememberName(d);
        if (!dCanon) continue;
        if (!normalizedLedger[dCanon]) normalizedLedger[dCanon] = {};
        for (const c in ledger[d]) {
            const cCanon = rememberName(c);
            if (!cCanon) continue;
            normalizedLedger[dCanon][cCanon] = (normalizedLedger[dCanon][cCanon] || 0) + (Number(ledger[d][c]) || 0);
        }
    }

    const userArr = Object.values(canonicalMap);
    userArr.forEach(u1 => { net[u1] = {}; });

    for (let i = 0; i < userArr.length; i++) {
        for (let j = i + 1; j < userArr.length; j++) {
            const u1 = userArr[i];
            const u2 = userArr[j];

            const u1OwesU2 = Number(normalizedLedger[u1]?.[u2]) || 0;
            const u2OwesU1 = Number(normalizedLedger[u2]?.[u1]) || 0;
            const diff = u2OwesU1 - u1OwesU2; // Positive means u2 owes u1

            if (Math.abs(diff) > 0.005) {
                net[u1][u2] = diff;
                net[u2][u1] = -diff;
            }
        }
    }
    return net;
}

// -------------------------------------------------------------
// 2. SESSION LEDGER MODAL & DEBT NOVATION / TRANSFER
// -------------------------------------------------------------
function openSessionLedgerModal() {
    const lifetimeModal = document.getElementById('lifetime-ledger-modal');
    if (lifetimeModal) {
        lifetimeModal.style.display = 'none';
        lifetimeModal.classList.add('hidden');
    }

    const modal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
    renderSessionLedger();
}

function closeSessionLedgerModal() {
    const modal = document.getElementById('session-ledger-modal') || document.getElementById('ledger-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}

function formatActivityTime(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return '';
    }
}

function renderSessionLedger(lobbyOverride) {
    const state = window.clientState || {};
    const lobby = lobbyOverride || window.appGlobals?.latestLobbySnapshot || {};

    const mainLedger = lobby.mainGameLedger || state.mainGameLedger || {};
    const sideLedger = lobby.sideBetLedger || state.sideBetLedger || {};
    const botLedger = lobby.botBetLedger || state.botBetLedger || {};
    const ledgerHistory = lobby.ledgerHistory || state.ledgerHistory || [];

    const container = document.getElementById('session-ledger-content') ||
                      document.getElementById('ledger-content') ||
                      document.getElementById('session-ledger-body');
    if (!container) return;

    const myUsername = resolveMyUsername();
    const myLower = myUsername.toLowerCase();

    // Combine Main + Side Bet ledgers for net human balances
    const combinedHuman = {};
    const mergeInto = (src) => {
        if (!src) return;
        for (const d in src) {
            if (!combinedHuman[d]) combinedHuman[d] = {};
            for (const c in src[d]) {
                combinedHuman[d][c] = (combinedHuman[d][c] || 0) + (Number(src[d][c]) || 0);
            }
        }
    };
    mergeInto(mainLedger);
    mergeInto(sideLedger);

    const netMatrix = calculatePairwiseNet(combinedHuman);
    const owedToMe = [];
    const iOwe = [];

    for (const p1 in netMatrix) {
        if (p1.toLowerCase() !== myLower) continue;
        for (const p2 in netMatrix[p1]) {
            const bal = netMatrix[p1][p2];
            if (bal > 0.005) {
                owedToMe.push({ other: p2, amount: bal });
            } else if (bal < -0.005) {
                iOwe.push({ other: p2, amount: Math.abs(bal) });
            }
        }
    }

    let html = buildLedgerSwitcherBarHTML('session');
    html += `<div style="display: flex; flex-direction: column; gap: 12px;">`;

    // Section A: Net Human Balances Involving Me
    if (owedToMe.length === 0 && iOwe.length === 0) {
        html += `
            <div style="text-align: center; color: #a7f3d0; padding: 14px; background: rgba(0,0,0,0.25); border-radius: 8px; font-size: 0.9rem;">
                All personal session balances settled ($0.00)
            </div>
        `;
    } else {
        owedToMe.forEach(item => {
            const safeOther = escapeHtml(item.other);
            const rawAttr = String(item.other || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const canTransfer = iOwe.length > 0;
            html += `
                <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.35); padding: 10px 12px; border-radius: 6px; border-left: 3px solid #10b981; gap: 8px; flex-wrap: wrap;">
                    <div style="font-size: 0.9rem;">
                        <strong style="color: #fca5a5;">${safeOther}</strong> owes <strong style="color: #34d399;">You</strong>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="color: #fbbf24; font-weight: 800; font-size: 1rem;">+$${item.amount.toFixed(2)}</span>
                        ${canTransfer ? `
                            <button type="button" onclick="openTransferDebtModal('${rawAttr}', ${item.amount})" style="background: #d97706; color: #fff; border: 1px solid #fbbf24; border-radius: 4px; padding: 4px 8px; font-size: 0.72rem; font-weight: 700; cursor: pointer; text-transform: uppercase;">
                                Transfer
                            </button>
                        ` : ''}
                        <button type="button" class="credit-action-btn" onclick="openSessionCreditDialog('${rawAttr}', ${item.amount})" style="background: linear-gradient(135deg, #059669 0%, #047857 100%); color: #ffffff; border: 1px solid #34d399; border-radius: 4px; padding: 4px 9px; font-size: 0.74rem; font-weight: 700; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                            Credit
                        </button>
                    </div>
                </div>
            `;
        });

        iOwe.forEach(item => {
            const safeOther = escapeHtml(item.other);
            const rawAttr = String(item.other || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const isPendingSession = window.pendingMarkedPaid && window.pendingMarkedPaid[`session:::${item.other.toLowerCase()}`];
            const markPaidBtnHTML = isPendingSession ? `
                <span style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid #f59e0b; border-radius: 4px; padding: 4px 8px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;">
                    ⏳ Pending
                </span>
            ` : `
                <button type="button" class="mark-paid-btn" onclick="openMarkPaidDialog('session', '', '${rawAttr}', ${item.amount})" style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; border: 1px solid #60a5fa; border-radius: 4px; padding: 4px 9px; font-size: 0.74rem; font-weight: 700; cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                    💸 Mark Paid
                </button>
            `;

            html += `
                <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.35); padding: 10px 12px; border-radius: 6px; border-left: 3px solid #ef4444; gap: 8px; flex-wrap: wrap;">
                    <div style="font-size: 0.9rem;">
                        <strong style="color: #f87171;">You</strong> owe <strong style="color: #86efac;">${safeOther}</strong>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="color: #f87171; font-weight: 800; font-size: 1rem;">-$${item.amount.toFixed(2)}</span>
                        ${markPaidBtnHTML}
                    </div>
                </div>
            `;
        });
    }

    // Section B: Bot Balances Involving Me
    const botNet = calculatePairwiseNet(botLedger);
    const botRows = [];
    for (const p1 in botNet) {
        if (p1.toLowerCase() !== myLower) continue;
        for (const p2 in botNet[p1]) {
            const bal = botNet[p1][p2];
            if (Math.abs(bal) > 0.005) {
                botRows.push({ bot: p2, amount: bal });
            }
        }
    }

    if (botRows.length > 0) {
        html += `<div style="margin-top: 4px; font-size: 0.78rem; color: #94a3b8; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">🤖 Bot Balances</div>`;
        botRows.forEach(r => {
            const isPos = r.amount > 0;
            const rawBotAttr = String(r.bot || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            html += `
                <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.22); padding: 7px 10px; border-radius: 6px; border-left: 3px solid ${isPos ? '#3b82f6' : '#64748b'}; font-size: 0.84rem; gap: 8px;">
                    <span>${isPos ? `${escapeHtml(r.bot)} owes You` : `You owe ${escapeHtml(r.bot)}`}</span>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <strong style="color: ${isPos ? '#60a5fa' : '#94a3b8'};">${isPos ? '+' : '-'}$${Math.abs(r.amount).toFixed(2)}</strong>
                        ${isPos ? `
                            <button type="button" class="credit-action-btn" onclick="openSessionCreditDialog('${rawBotAttr}', ${r.amount})" style="background: linear-gradient(135deg, #059669 0%, #047857 100%); color: #ffffff; border: 1px solid #34d399; border-radius: 4px; padding: 3px 8px; font-size: 0.7rem; font-weight: 700; cursor: pointer; text-transform: uppercase;">
                                Credit
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        });
    }

    // Section C: Collapsible Recent Activity Log
    html += `
        <details style="margin-top: 6px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(251, 191, 36, 0.25); border-radius: 8px; padding: 8px 10px;">
            <summary style="cursor: pointer; color: #fbbf24; font-size: 0.82rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; user-select: none;">
                📜 Recent Activity (${ledgerHistory.length})
            </summary>
            <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px; max-height: 170px; overflow-y: auto;">
    `;

    if (ledgerHistory.length === 0) {
        html += `<div style="color: #94a3b8; font-size: 0.8rem; text-align: center; padding: 6px 0;">No transactions recorded yet this session.</div>`;
    } else {
        ledgerHistory.forEach(item => {
            const timeStr = formatActivityTime(item.timestamp);
            html += `
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; background: rgba(255,255,255,0.04); padding: 6px 8px; border-radius: 5px; font-size: 0.8rem; color: #e2e8f0;">
                    <span style="line-height: 1.3;">${escapeHtml(item.text)}</span>
                    <span style="color: #94a3b8; font-size: 0.7rem; white-space: nowrap; flex-shrink: 0;">${timeStr}</span>
                </div>
            `;
        });
    }

    html += `
            </div>
        </details>
    </div>`;

    container.innerHTML = html;
}

function ensureTransferModalDOM() {
    let modal = document.getElementById('transfer-debt-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'transfer-debt-modal';
        modal.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.78); display: none; align-items: center; justify-content: center; z-index: 100050; padding: 16px;`;
        modal.innerHTML = `
            <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #fbbf24; border-radius: 10px; width: 100%; max-width: 360px; padding: 18px; color: #fff; box-shadow: 0 10px 30px rgba(0,0,0,0.85);">
                <h3 style="margin: 0 0 8px; color: #fbbf24; text-align: center; font-size: 1.1rem;">🔄 Transfer Debt</h3>
                <p id="transfer-debt-desc" style="font-size: 0.85rem; color: #cbd5e1; text-align: center; margin: 0 0 12px;"></p>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <label style="font-size: 0.8rem; color: #a7f3d0; font-weight: 600;">Transfer To (Someone You Owe):</label>
                    <select id="transfer-target-select" style="padding: 8px; border-radius: 6px; background: #042f2e; color: #fff; border: 1px solid #d97706; font-size: 0.9rem;"></select>
                    <label style="font-size: 0.8rem; color: #a7f3d0; font-weight: 600;">Amount ($):</label>
                    <input type="number" id="transfer-amount-input" min="1" step="1" style="padding: 8px; border-radius: 6px; background: #042f2e; color: #fff; border: 1px solid #d97706; font-size: 0.95rem;" />
                    <div style="display: flex; gap: 8px; margin-top: 6px;">
                        <button type="button" id="transfer-confirm-btn" style="flex: 1; background: #10b981; color: #fff; border: none; border-radius: 6px; padding: 10px; font-weight: 700; cursor: pointer;">Confirm</button>
                        <button type="button" onclick="closeTransferDebtModal()" style="flex: 1; background: #475569; color: #fff; border: none; border-radius: 6px; padding: 10px; font-weight: 700; cursor: pointer;">Cancel</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    return modal;
}

function openTransferDebtModal(debtorName, maxOwed) {
    const modal = ensureTransferModalDOM();
    const state = window.clientState || {};
    const lobby = window.appGlobals?.latestLobbySnapshot || {};
    const mainLedger = lobby.mainGameLedger || state.mainGameLedger || {};
    const sideLedger = lobby.sideBetLedger || state.sideBetLedger || {};

    const combined = {};
    const merge = (src) => {
        if (!src) return;
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
    const myLower = resolveMyUsername().toLowerCase();
    const creditors = [];

    for (const p1 in netMatrix) {
        if (p1.toLowerCase() !== myLower) continue;
        for (const p2 in netMatrix[p1]) {
            const bal = netMatrix[p1][p2];
            if (bal < -0.005) {
                creditors.push({ username: p2, owedByMe: Math.abs(bal) });
            }
        }
    }

    if (creditors.length === 0) {
        alert("You don't currently owe anyone to transfer this debt to.");
        return;
    }

    const desc = document.getElementById('transfer-debt-desc');
    const select = document.getElementById('transfer-target-select');
    const input = document.getElementById('transfer-amount-input');
    const confirmBtn = document.getElementById('transfer-confirm-btn');

    if (desc) {
        desc.innerHTML = `<strong style="color:#fca5a5;">${escapeHtml(debtorName)}</strong> owes you <strong>$${Number(maxOwed).toFixed(2)}</strong>.`;
    }

    if (select) {
        select.innerHTML = creditors.map(c =>
            `<option value="${escapeHtml(c.username)}" data-max="${c.owedByMe}">${escapeHtml(c.username)} (You owe $${c.owedByMe.toFixed(2)})</option>`
        ).join('');
        select.onchange = () => {
            const selMax = parseFloat(select.selectedOptions[0]?.dataset.max || maxOwed);
            const cap = Math.min(maxOwed, selMax);
            if (input) {
                input.max = cap;
                input.value = cap;
            }
        };
    }

    const initialCap = Math.min(maxOwed, creditors[0].owedByMe);
    if (input) {
        input.max = initialCap;
        input.value = initialCap;
    }

    if (confirmBtn) {
        confirmBtn.onclick = () => confirmDebtTransfer(debtorName, maxOwed);
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function closeTransferDebtModal() {
    const modal = document.getElementById('transfer-debt-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
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

    const maxAllowed = Math.min(maxOwed, parseFloat(targetSelect.selectedOptions[0]?.dataset.max || maxOwed));
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
        if (!src) return;
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
    const myUsernameLower = resolveMyUsername().toLowerCase();
    const rows = [];
    const processedPairs = new Set();

    for (const p1 in netMatrix) {
        for (const p2 in netMatrix[p1]) {
            const pairKey = [p1.toLowerCase(), p2.toLowerCase()].sort().join(':::');
            if (processedPairs.has(pairKey)) continue;
            processedPairs.add(pairKey);

            const balance = netMatrix[p1][p2];
            if (balance > 0.005) {
                if (!myUsernameLower || p1.toLowerCase() === myUsernameLower || p2.toLowerCase() === myUsernameLower) {
                    rows.push({ debtor: p2, creditor: p1, amount: balance });
                }
            } else if (balance < -0.005) {
                if (!myUsernameLower || p1.toLowerCase() === myUsernameLower || p2.toLowerCase() === myUsernameLower) {
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
        const token = sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || localStorage.getItem('token') || localStorage.getItem('auth_token') || localStorage.getItem('p31_token');
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

function getLedgerAuthToken() {
    return sessionStorage.getItem('31_jwt')
        || localStorage.getItem('31_jwt')
        || localStorage.getItem('token')
        || localStorage.getItem('auth_token')
        || localStorage.getItem('p31_token')
        || null;
}

function requestLifetimeLedger() {
    const uid = getCurrentUserId();
    const uname = resolveMyUsername();
    const token = getLedgerAuthToken();
    sendLedgerSocket({
        type: 'GET_LIFETIME_LEDGER',
        userId: uid,
        username: uname,
        token
    });
}

function openLifetimeLedgerModal() {
    const sessionModal = document.getElementById('session-ledger-modal');
    if (sessionModal) {
        sessionModal.style.display = 'none';
        sessionModal.classList.add('hidden');
    }

    const modal = document.getElementById('lifetime-ledger-modal') || document.getElementById('ledger-modal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
    renderLifetimeLedger(cachedLifetimeRows);
    requestLifetimeLedger();
}

function closeLifetimeLedgerModal() {
    const modal = document.getElementById('lifetime-ledger-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}

let cachedLifetimeRows = [];

function renderLifetimeLedger(data) {
    const container = document.getElementById('lifetime-ledger-table-container') ||
                      document.getElementById('lifetime-ledger-content');
    if (!container) return;

    const rawList = Array.isArray(data)
        ? data
        : (data?.balances || data?.ledger || data?.debts || []);

    cachedLifetimeRows = Array.isArray(rawList) ? rawList : [];
    window.cachedLifetimeBalancesList = cachedLifetimeRows;

    const activeRows = cachedLifetimeRows.filter(r => Math.abs(Number(r.net_balance ?? r.net ?? r.amount ?? 0)) > 0.005);

    const gameView = document.getElementById('game-view');
    const isInGame = Boolean(gameView && gameView.style.display === 'flex');
    let html = isInGame ? buildLedgerSwitcherBarHTML('lifetime') : '';

    if (activeRows.length === 0) {
        html += `
            <div style="text-align: center; color: #a7f3d0; padding: 1.25rem; font-size: 0.92rem;">
                All lifetime balances settled ($0.00)
            </div>
        `;
        container.innerHTML = html;
        return;
    }

    const iOweRows = activeRows.filter(r => Number(r.net_balance ?? r.net ?? r.amount ?? 0) < -0.005);

    html += '<div style="display: flex; flex-direction: column; gap: 0.65rem;">';

    activeRows.forEach(row => {
        const net = Number(row.net_balance ?? r.net ?? row.net ?? row.amount ?? 0);
        const otherName = escapeHtml(row.other_username || row.username || 'Player');
        const rawNameAttr = String(row.other_username || row.username || 'Player').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const otherId = row.other_id || row.userId || row.id;

        if (net > 0) {
            const canTransferLifetime = iOweRows.length > 0;
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
                        ${canTransferLifetime ? `
                            <button type="button" onclick="openLifetimeTransferModal('${otherId}', '${rawNameAttr}', ${net})" style="background: #d97706; color: #ffffff; border: 1px solid #fbbf24; border-radius: 4px; padding: 4px 8px; font-size: 0.74rem; font-weight: 700; cursor: pointer; text-transform: uppercase;">
                                Transfer
                            </button>
                        ` : ''}
                        <button type="button" class="credit-action-btn" onclick="openCreditDialog('${otherId}', '${rawNameAttr}', ${net})" style="background: linear-gradient(135deg, #059669 0%, #047857 100%); color: #ffffff; border: 1px solid #34d399; border-radius: 4px; padding: 4px 9px; font-size: 0.76rem; font-weight: 700; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                            Credit
                        </button>
                    </div>
                </div>
            `;
        } else {
            const absDebt = Math.abs(net);
            const isPendingLifetime = window.pendingMarkedPaid && window.pendingMarkedPaid[`lifetime:::${otherId}`];
            const markPaidLifetimeBtn = isPendingLifetime ? `
                <span style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid #f59e0b; border-radius: 4px; padding: 4px 8px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;">
                    ⏳ Pending
                </span>
            ` : `
                <button type="button" class="mark-paid-btn" onclick="openMarkPaidDialog('lifetime', '${otherId}', '${rawNameAttr}', ${absDebt})" style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; border: 1px solid #60a5fa; border-radius: 4px; padding: 4px 9px; font-size: 0.76rem; font-weight: 700; cursor: pointer; text-transform: uppercase; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                    💸 Mark Paid
                </button>
            `;

            html += `
                <div class="lifetime-row-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.35); padding: 0.75rem 0.9rem; border-radius: 6px; border-left: 3px solid #ef4444; flex-wrap: wrap; gap: 0.5rem;">
                    <div style="font-size: 0.92rem;">
                        <span style="color: #f87171; font-weight: 700;">You</span> owe 
                        <span style="color: #86efac; font-weight: 600;">${otherName}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.55rem;">
                        <span style="font-weight: 700; color: #f87171; font-size: 1.05rem;">
                            -$${absDebt.toFixed(2)}
                        </span>
                        ${markPaidLifetimeBtn}
                    </div>
                </div>
            `;
        }
    });

    html += '</div>';
    container.innerHTML = html;
}

// -------------------------------------------------------------
// 5. LIFETIME DEBT TRANSFER MODAL
// -------------------------------------------------------------
function openLifetimeTransferModal(fromDebtorId, debtorName, maxOwed) {
    const modal = ensureTransferModalDOM();
    const creditors = cachedLifetimeRows
        .filter(r => Number(r.net_balance ?? r.net ?? r.amount ?? 0) < -0.005)
        .map(r => ({
            id: r.other_id || r.userId || r.id,
            username: r.other_username || r.username || 'Player',
            owedByMe: Math.abs(Number(r.net_balance ?? r.net ?? r.amount ?? 0))
        }));

    if (creditors.length === 0) {
        alert("You don't owe anyone in your lifetime ledger to transfer this balance to.");
        return;
    }

    const desc = document.getElementById('transfer-debt-desc');
    const select = document.getElementById('transfer-target-select');
    const input = document.getElementById('transfer-amount-input');
    const confirmBtn = document.getElementById('transfer-confirm-btn');

    if (desc) {
        desc.innerHTML = `<strong style="color:#fca5a5;">${escapeHtml(debtorName)}</strong> owes you <strong>$${Number(maxOwed).toFixed(2)}</strong> (Lifetime).`;
    }

    if (select) {
        select.innerHTML = creditors.map(c =>
            `<option value="${escapeHtml(String(c.id))}" data-max="${c.owedByMe}">${escapeHtml(c.username)} (You owe $${c.owedByMe.toFixed(2)})</option>`
        ).join('');
        select.onchange = () => {
            const selMax = parseFloat(select.selectedOptions[0]?.dataset.max || maxOwed);
            const cap = Math.min(maxOwed, selMax);
            if (input) {
                input.max = cap;
                input.value = cap;
            }
        };
    }

    const initialCap = Math.min(maxOwed, creditors[0].owedByMe);
    if (input) {
        input.max = initialCap;
        input.value = initialCap;
    }

    if (confirmBtn) {
        confirmBtn.onclick = () => confirmLifetimeDebtTransfer(fromDebtorId, maxOwed);
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function confirmLifetimeDebtTransfer(fromDebtorId, maxOwed) {
    const targetSelect = document.getElementById('transfer-target-select');
    const amountInput = document.getElementById('transfer-amount-input');
    if (!targetSelect || !amountInput) return;

    const toCreditorId = targetSelect.value;
    const amount = parseFloat(amountInput.value);

    if (isNaN(amount) || amount <= 0) {
        alert("Please enter a valid amount.");
        return;
    }

    const maxAllowed = Math.min(maxOwed, parseFloat(targetSelect.selectedOptions[0]?.dataset.max || maxOwed));
    if (amount > maxAllowed) {
        alert(`Maximum transferable amount is $${maxAllowed.toFixed(2)}.`);
        return;
    }

    sendLedgerSocket({
        type: 'TRANSFER_LIFETIME_DEBT',
        myId: getCurrentUserId(),
        username: resolveMyUsername(),
        fromDebtorId,
        toCreditorId,
        amount
    });

    closeTransferDebtModal();
}

// -------------------------------------------------------------
// 6. CREDIT & SETTLEMENT DIALOG ENGINE (SESSION & LIFETIME)
// -------------------------------------------------------------
let activeCreditTarget = null;

function ensureCreditModalDOM() {
    let modal = document.getElementById('credit-settle-dialog');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'credit-settle-dialog';
        modal.style.cssText = `position: fixed; inset: 0; background: rgba(0, 0, 0, 0.78); display: none; align-items: center; justify-content: center; z-index: 100050; padding: 16px;`;
        modal.innerHTML = `
            <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #d97706; border-radius: 10px; width: 100%; max-width: 360px; padding: 18px; box-shadow: 0 8px 30px rgba(0,0,0,0.85); color: #f8fafc; font-family: inherit;">
                <h3 style="margin: 0 0 6px; color: #fbbf24; font-size: 1.15rem; text-align: center; text-transform: uppercase;">Apply Credit / Settle</h3>
                <p id="credit-dialog-subtitle" style="margin: 0 0 14px; font-size: 0.88rem; text-align: center; color: #cbd5e1;"></p>
                <div style="display: flex; gap: 8px; margin-bottom: 14px;">
                    <input type="number" id="credit-dialog-amount" min="0.01" step="0.01" style="flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #d97706; background: rgba(0,0,0,0.4); color: #fff; font-size: 1rem;" />
                    <button type="button" id="credit-dialog-full-btn" style="background: #0284c7; color: #fff; border: none; border-radius: 6px; padding: 0 12px; font-weight: 700; cursor: pointer; font-size: 0.8rem;">Full</button>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button type="button" id="credit-dialog-confirm-btn" style="flex: 1; background: #10b981; color: #fff; border: none; border-radius: 6px; padding: 10px; font-weight: 700; cursor: pointer;">Apply Credit</button>
                    <button type="button" onclick="closeCreditDialog()" style="flex: 1; background: #475569; color: #fff; border: none; border-radius: 6px; padding: 10px; font-weight: 700; cursor: pointer;">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    return modal;
}

function openSessionCreditDialog(debtorName, maxAmount) {
    const modal = ensureCreditModalDOM();
    const cleanMax = Number(maxAmount) || 0;
    activeCreditTarget = { mode: 'session', debtorName, maxAmount: cleanMax };

    const subtitle = document.getElementById('credit-dialog-subtitle');
    const input = document.getElementById('credit-dialog-amount');
    const fullBtn = document.getElementById('credit-dialog-full-btn');
    const confirmBtn = document.getElementById('credit-dialog-confirm-btn');

    if (subtitle) {
        subtitle.innerHTML = `Credit session debt owed by <b style="color: #fca5a5;">${escapeHtml(debtorName)}</b> (Max: $${cleanMax.toFixed(2)})`;
    }
    if (input) {
        input.value = cleanMax.toFixed(2);
        input.max = cleanMax;
    }
    if (fullBtn) {
        fullBtn.onclick = () => {
            if (input) input.value = cleanMax.toFixed(2);
        };
    }
    if (confirmBtn) {
        confirmBtn.onclick = () => {
            const entered = Number(input.value);
            if (!entered || entered <= 0) {
                alert('Please enter a valid credit amount.');
                return;
            }
            if (entered > cleanMax + 0.005) {
                alert(`Credit amount cannot exceed total debt owed ($${cleanMax.toFixed(2)}).`);
                return;
            }
            applySessionSettlementCredit(debtorName, Math.min(entered, cleanMax));
            closeCreditDialog();
        };
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function applySessionSettlementCredit(debtorName, amount) {
    const cleanAmount = Number(amount);
    if (!debtorName || !cleanAmount || cleanAmount <= 0) return;

    const myUsername = resolveMyUsername();
    const roomCode = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room');

    sendLedgerSocket({
        type: 'APPLY_SESSION_CREDIT',
        debtor: debtorName,
        creditor: myUsername,
        amount: cleanAmount,
        code: roomCode
    });
}

function openCreditDialog(debtorId, debtorName, maxAmount) {
    const modal = ensureCreditModalDOM();
    const cleanMax = Number(maxAmount) || 0;
    activeCreditTarget = { mode: 'lifetime', debtorId, debtorName, maxAmount: cleanMax };

    const subtitle = document.getElementById('credit-dialog-subtitle');
    const input = document.getElementById('credit-dialog-amount');
    const fullBtn = document.getElementById('credit-dialog-full-btn');
    const confirmBtn = document.getElementById('credit-dialog-confirm-btn');

    if (subtitle) {
        subtitle.innerHTML = `Credit lifetime debt owed by <b style="color: #fca5a5;">${escapeHtml(debtorName)}</b> (Max: $${cleanMax.toFixed(2)})`;
    }
    if (input) {
        input.value = cleanMax.toFixed(2);
        input.max = cleanMax;
    }
    if (fullBtn) {
        fullBtn.onclick = () => {
            if (input) input.value = cleanMax.toFixed(2);
        };
    }
    if (confirmBtn) {
        confirmBtn.onclick = () => {
            const entered = Number(input.value);
            if (!entered || entered <= 0) {
                alert('Please enter a valid credit amount.');
                return;
            }
            if (entered > cleanMax + 0.005) {
                alert(`Credit amount cannot exceed total debt owed ($${cleanMax.toFixed(2)}).`);
                return;
            }
            applySettlementCredit(debtorId, Math.min(entered, cleanMax));
            closeCreditDialog();
        };
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function closeCreditDialog() {
    const modal = document.getElementById('credit-settle-dialog');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
    activeCreditTarget = null;
}

function applySettlementCredit(otherUserId, amount) {
    const token = getLedgerAuthToken();
    const myId = getCurrentUserId();
    const cleanAmount = Number(amount);
    if (!cleanAmount || cleanAmount <= 0) return;

    sendLedgerSocket({
        type: 'APPLY_CREDIT',
        debtorId: myId,
        creditorId: otherUserId,
        username: resolveMyUsername(),
        amount: cleanAmount,
        token: token || null
    });

    const container = document.getElementById('lifetime-ledger-table-container');
    if (container) {
        const gameView = document.getElementById('game-view');
        const isInGame = Boolean(gameView && gameView.style.display === 'flex');
        container.innerHTML = (isInGame ? buildLedgerSwitcherBarHTML('lifetime') : '') + `
            <div class="ledger-loading-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                Applying credit of $${cleanAmount.toFixed(2)}...
            </div>
        `;
    }
}

// Legacy fallback so any call to clearDebtCategory opens the Session Credit dialog or credits the balance
window.clearDebtCategory = function(targetUser, category, amountOverride) {
    if (amountOverride && Number(amountOverride) > 0) {
        openSessionCreditDialog(targetUser, Number(amountOverride));
        return;
    }
    sendLedgerSocket({
        type: 'CLEAR_DEBT',
        debtor: targetUser,
        creditor: resolveMyUsername(),
        ledgerType: category || 'main',
        code: window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room')
    });
};

// -------------------------------------------------------------
// 6B. DEBTOR "MARK PAID" & CREDITOR CONFIRMATION ENGINE
// -------------------------------------------------------------
window.pendingMarkedPaid = window.pendingMarkedPaid || {};
window.incomingPayConfirmQueue = window.incomingPayConfirmQueue || [];

function ensureMarkPaidModalDOM() {
    let modal = document.getElementById('mark-paid-dialog');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'mark-paid-dialog';
        modal.style.cssText = `
            position: fixed; inset: 0; background: rgba(0, 0, 0, 0.78);
            display: none; align-items: center; justify-content: center;
            z-index: 100055; padding: 16px;
        `;
        modal.innerHTML = `
            <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #60a5fa; border-radius: 10px; width: 100%; max-width: 360px; padding: 18px; box-shadow: 0 8px 30px rgba(0,0,0,0.85); color: #f8fafc; font-family: inherit;">
                <h3 style="margin: 0 0 6px; color: #60a5fa; font-size: 1.15rem; text-align: center; text-transform: uppercase;">💸 Mark Debt as Paid</h3>
                <p id="mark-paid-subtitle" style="margin: 0 0 14px; font-size: 0.86rem; text-align: center; color: #cbd5e1;"></p>

                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <label style="font-size: 0.78rem; color: #94a3b8; text-transform: uppercase; font-weight: 600;">Amount Paid ($)</label>
                        <input id="mark-paid-amount" type="number" step="0.5" min="0.5" style="background: #020a06; border: 1.5px solid #60a5fa; border-radius: 5px; color: #fff; padding: 8px 10px; font-size: 1.05rem; font-weight: bold; outline: none; width: 100%; box-sizing: border-box;" />
                    </div>

                    <div style="display: flex; gap: 6px;">
                        <button type="button" id="mark-paid-full-btn" style="flex: 1; background: rgba(59, 130, 246, 0.2); border: 1px solid #60a5fa; color: #93c5fd; border-radius: 4px; padding: 6px; font-size: 0.8rem; font-weight: 700; cursor: pointer;">
                            Full Balance
                        </button>
                    </div>

                    <div style="display: flex; gap: 8px; margin-top: 6px;">
                        <button type="button" onclick="closeMarkPaidDialog()" style="flex: 1; background: #334155; color: #e2e8f0; border: none; border-radius: 5px; padding: 9px; font-size: 0.85rem; font-weight: 700; cursor: pointer;">
                            Cancel
                        </button>
                        <button type="button" id="mark-paid-send-btn" style="flex: 1; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; border: 1px solid #60a5fa; border-radius: 5px; padding: 9px; font-size: 0.85rem; font-weight: 700; cursor: pointer;">
                            Notify Creditor
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    return modal;
}

function openMarkPaidDialog(scope, creditorId, creditorName, maxAmount) {
    const modal = ensureMarkPaidModalDOM();
    const cleanMax = Number(maxAmount) || 0;
    const subtitle = document.getElementById('mark-paid-subtitle');
    const input = document.getElementById('mark-paid-amount');
    const fullBtn = document.getElementById('mark-paid-full-btn');
    const sendBtn = document.getElementById('mark-paid-send-btn');

    if (subtitle) {
        subtitle.innerHTML = `Send a confirmation prompt to <b style="color: #86efac;">${escapeHtml(creditorName)}</b> that you paid them (Max: $${cleanMax.toFixed(2)})`;
    }
    if (input) {
        input.value = cleanMax.toFixed(2);
        input.max = cleanMax;
    }
    if (fullBtn) {
        fullBtn.onclick = () => {
            if (input) input.value = cleanMax.toFixed(2);
        };
    }
    if (sendBtn) {
        sendBtn.onclick = () => {
            const entered = Number(input.value);
            if (!entered || entered <= 0) {
                alert('Please enter a valid payment amount.');
                return;
            }
            if (entered > cleanMax + 0.005) {
                alert(`Amount cannot exceed what you owe ($${cleanMax.toFixed(2)}).`);
                return;
            }
            submitMarkPaidRequest(scope, creditorId, creditorName, Math.min(entered, cleanMax));
            closeMarkPaidDialog();
        };
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function closeMarkPaidDialog() {
    const modal = document.getElementById('mark-paid-dialog');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}

function submitMarkPaidRequest(scope, creditorId, creditorName, amount) {
    const token = getLedgerAuthToken();
    const myId = getCurrentUserId();
    const myUsername = resolveMyUsername();
    const roomCode = window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room') || null;

    const pendingKey = scope === 'lifetime'
        ? `lifetime:::${creditorId}`
        : `session:::${String(creditorName || '').toLowerCase()}`;
    window.pendingMarkedPaid[pendingKey] = true;

    sendLedgerSocket({
        type: 'MARK_DEBT_PAID',
        scope: scope === 'lifetime' ? 'lifetime' : 'session',
        debtorId: myId,
        debtorUsername: myUsername,
        creditorId: creditorId || null,
        creditorUsername: creditorName || null,
        amount: Number(amount),
        code: roomCode,
        token: token
    });

    if (typeof window.showCenterNotification === 'function') {
        window.showCenterNotification(`💸 Sent $${Number(amount).toFixed(2)} paid confirmation to ${creditorName}!`);
    }

    if (scope === 'lifetime') {
        renderLifetimeLedger(cachedLifetimeRows);
    } else {
        renderSessionLedger();
    }
}

function ensureCreditorConfirmModalDOM() {
    let modal = document.getElementById('creditor-confirm-paid-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'creditor-confirm-paid-modal';
        modal.style.cssText = `
            position: fixed; inset: 0; background: rgba(0, 0, 0, 0.82);
            display: none; align-items: center; justify-content: center;
            z-index: 100060; padding: 16px;
        `;
        document.body.appendChild(modal);
    }
    return modal;
}

function handlePaymentConfirmPrompt(payload) {
    if (!payload || !payload.requestId) return;

    if (!window.incomingPayConfirmQueue.some(r => r.requestId === payload.requestId)) {
        window.incomingPayConfirmQueue.push(payload);
    }
    renderNextCreditorConfirmModal();
}

function renderNextCreditorConfirmModal() {
    const modal = ensureCreditorConfirmModalDOM();
    if (window.incomingPayConfirmQueue.length === 0) {
        modal.style.display = 'none';
        return;
    }

    const req = window.incomingPayConfirmQueue[0];
    const debtorName = escapeHtml(req.debtorUsername || 'Player');
    const amtFormatted = Number(req.amount || 0).toFixed(2);
    const scopeLabel = req.scope === 'lifetime' ? 'Lifetime Ledger' : 'Session Ledger';

    modal.innerHTML = `
        <div style="background: radial-gradient(circle at 50% 50%, #064e3b 0%, #022c22 100%); border: 2px solid #fbbf24; border-radius: 10px; width: 100%; max-width: 370px; padding: 18px; box-shadow: 0 10px 35px rgba(0,0,0,0.9); color: #f8fafc; font-family: inherit; text-align: center;">
            <div style="font-size: 0.72rem; color: #fbbf24; text-transform: uppercase; font-weight: 800; letter-spacing: 0.8px; margin-bottom: 4px;">
                ${scopeLabel} Settlement Request
            </div>
            <h3 style="margin: 0 0 10px; color: #ffffff; font-size: 1.15rem;">
                💸 Confirm Payment Received?
            </h3>
            <p style="margin: 0 0 16px; font-size: 0.92rem; color: #e2e8f0; line-height: 1.4;">
                <strong style="color: #fca5a5;">${debtorName}</strong> marked <strong style="color: #34d399;">$${amtFormatted}</strong> as paid to you.
            </p>
            <div style="display: flex; gap: 10px;">
                <button type="button" onclick="respondToMarkPaid('${req.requestId}', false)" style="flex: 1; background: #7f1d1d; color: #fecaca; border: 1px solid #ef4444; border-radius: 6px; padding: 10px; font-size: 0.85rem; font-weight: 700; cursor: pointer;">
                    ✕ Decline
                </button>
                <button type="button" onclick="respondToMarkPaid('${req.requestId}', true)" style="flex: 1; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; border: 1px solid #34d399; border-radius: 6px; padding: 10px; font-size: 0.85rem; font-weight: 700; cursor: pointer;">
                    ✅ Confirm ($${amtFormatted})
                </button>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
}

function respondToMarkPaid(requestId, confirmed) {
    const req = window.incomingPayConfirmQueue.find(r => r.requestId === requestId);
    window.incomingPayConfirmQueue = window.incomingPayConfirmQueue.filter(r => r.requestId !== requestId);
    renderNextCreditorConfirmModal();

    const token = getLedgerAuthToken();
    const roomCode = (req && req.code) || window.appGlobals?.currentJoinedCode || localStorage.getItem('blitz31_active_room') || null;

    sendLedgerSocket({
        type: 'RESPOND_MARK_PAID',
        requestId: requestId,
        confirm: Boolean(confirmed),
        code: roomCode,
        token: token
    });
}

function handlePaymentConfirmResult(payload) {
    if (!payload) return;
    if (payload.creditorId) {
        delete window.pendingMarkedPaid[`lifetime:::${payload.creditorId}`];
    }
    if (payload.creditorUsername) {
        delete window.pendingMarkedPaid[`session:::${String(payload.creditorUsername).toLowerCase()}`];
    }

    if (payload.message && typeof window.showCenterNotification === 'function') {
        window.showCenterNotification(payload.message);
    } else if (payload.message) {
        alert(payload.message);
    }

    if (payload.scope === 'lifetime') {
        requestLifetimeLedger();
    } else {
        renderSessionLedger();
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
        .replace(/'/g, '&#39;');
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
window.openSessionCreditDialog = openSessionCreditDialog;
window.applySessionSettlementCredit = applySessionSettlementCredit;
window.openCreditDialog = openCreditDialog;
window.closeCreditDialog = closeCreditDialog;
window.applySettlementCredit = applySettlementCredit;
window.openMarkPaidDialog = openMarkPaidDialog;
window.closeMarkPaidDialog = closeMarkPaidDialog;
window.submitMarkPaidRequest = submitMarkPaidRequest;
window.handlePaymentConfirmPrompt = handlePaymentConfirmPrompt;
window.respondToMarkPaid = respondToMarkPaid;
window.handlePaymentConfirmResult = handlePaymentConfirmResult;
window.escapeHtml = escapeHtml;
