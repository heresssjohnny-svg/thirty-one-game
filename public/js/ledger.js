// public/js/ledger.js - Pairwise Debt Netting, Modal Renderer & Canvas Snapshot Exporter

// -------------------------------------------------------------
// 1. MODAL ELEMENT RESOLVER & TOGGLE CONTROLS
// -------------------------------------------------------------
function getLedgerModal() {
    return document.getElementById('session-ledger-modal') ||
           document.getElementById('ledger-modal') ||
           document.getElementById('lifetime-ledger-modal');
}

window.toggleLedgerModal = window.openLedgerModal = window.toggleSessionLedger = function(forceState) {
    const modal = getLedgerModal();
    if (!modal) {
        alert("Ledger modal element not found in DOM.");
        return;
    }

    const isCurrentlyOpen = modal.style.display === 'flex' || modal.style.display === 'block';
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !isCurrentlyOpen;

    if (shouldOpen) {
        modal.style.display = 'flex';
        // Request fresh lifetime data from server
        if (typeof window.initSocketAndSend === 'function') {
            window.initSocketAndSend({ type: 'GET_LIFETIME_LEDGER' });
        }
        window.renderSessionLedger();
    } else {
        modal.style.display = 'none';
    }
};

window.closeLedgerModal = function() {
    window.toggleLedgerModal(false);
};

// -------------------------------------------------------------
// 2. PAIRWISE DEBT NETTING ALGORITHM
// -------------------------------------------------------------
window.calculatePairwiseNet = function(rawLedger) {
    if (!rawLedger || typeof rawLedger !== 'object') return [];

    const pairwiseMap = {};

    // Collect all debts: debtor owes creditor amount
    for (const debtor in rawLedger) {
        for (const creditor in rawLedger[debtor]) {
            if (debtor === creditor) continue;
            const amount = Number(rawLedger[debtor][creditor]) || 0;
            if (amount <= 0) continue;

            const pairKey = [debtor, creditor].sort().join(':::');
            if (!pairwiseMap[pairKey]) {
                pairwiseMap[pairKey] = {
                    p1: [debtor, creditor].sort()[0],
                    p2: [debtor, creditor].sort()[1],
                    net: 0 // Positive means p1 owes p2, negative means p2 owes p1
                };
            }

            if (debtor === pairwiseMap[pairKey].p1) {
                pairwiseMap[pairKey].net += amount;
            } else {
                pairwiseMap[pairKey].net -= amount;
            }
        }
    }

    const netResults = [];
    for (const key in pairwiseMap) {
        const item = pairwiseMap[key];
        if (item.net > 0) {
            netResults.push({ debtor: item.p1, creditor: item.p2, amount: item.net });
        } else if (item.net < 0) {
            netResults.push({ debtor: item.p2, creditor: item.p1, amount: Math.abs(item.net) });
        }
    }

    return netResults;
};

// -------------------------------------------------------------
// 3. LEDGER RENDERING (SESSION & LIFETIME)
// -------------------------------------------------------------
window.activeLedgerTab = 'session'; // 'session' or 'lifetime'

window.switchLedgerTab = function(tabName) {
    window.activeLedgerTab = tabName;
    const sessionTabBtn = document.getElementById('ledger-tab-session-btn');
    const lifetimeTabBtn = document.getElementById('ledger-tab-lifetime-btn');

    if (sessionTabBtn && lifetimeTabBtn) {
        if (tabName === 'session') {
            sessionTabBtn.classList.add('active');
            lifetimeTabBtn.classList.remove('active');
        } else {
            sessionTabBtn.classList.remove('active');
            lifetimeTabBtn.classList.add('active');
        }
    }

    if (tabName === 'session') {
        window.renderSessionLedger();
    } else {
        window.renderLifetimeLedger(window.cachedLifetimeBalances || {});
    }
};

window.renderSessionLedger = function() {
    const modal = getLedgerModal();
    if (!modal) return;

    let contentBox = modal.querySelector('#ledger-modal-body') ||
                     modal.querySelector('.ledger-content-body') ||
                     modal.querySelector('.modal-content') ||
                     modal.querySelector('.modal-box');
    if (!contentBox) return;

    const lobby = window.appGlobals?.latestLobbySnapshot || {};
    const mainGameNet = window.calculatePairwiseNet(lobby.mainGameLedger || window.clientState?.mainGameLedger || {});
    const sideBetNet = window.calculatePairwiseNet(lobby.sideBetLedger || window.clientState?.sideBetLedger || {});
    const botBetNet = window.calculatePairwiseNet(lobby.botBetLedger || window.clientState?.botBetLedger || {});

    const hasAnyDebts = mainGameNet.length > 0 || sideBetNet.length > 0 || botBetNet.length > 0;

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.15); padding-bottom:8px;">
            <div style="display:flex; gap:8px;">
                <button id="ledger-tab-session-btn" onclick="window.switchLedgerTab('session')" style="background:${window.activeLedgerTab === 'session' ? 'var(--accent-gold)' : 'rgba(255,255,255,0.1)'}; color:${window.activeLedgerTab === 'session' ? '#000' : '#fff'}; font-weight:700;">Current Session</button>
                <button id="ledger-tab-lifetime-btn" onclick="window.switchLedgerTab('lifetime')" style="background:${window.activeLedgerTab === 'lifetime' ? 'var(--accent-gold)' : 'rgba(255,255,255,0.1)'}; color:${window.activeLedgerTab === 'lifetime' ? '#000' : '#fff'}; font-weight:700;">Lifetime</button>
            </div>
            <button onclick="window.closeLedgerModal()" class="secondary" style="padding:4px 8px;">✕</button>
        </div>
    `;

    if (!hasAnyDebts) {
        html += `<div style="text-align:center; padding:24px 0; color:var(--text-muted); font-size:0.9rem;">No active session debts. All players are even.</div>`;
    } else {
        html += `<div style="display:flex; flex-direction:column; gap:12px; max-height:55vh; overflow-y:auto; padding-right:4px;">`;

        if (mainGameNet.length > 0) {
            html += `<div style="font-weight:700; color:var(--accent-gold); font-size:0.82rem; text-transform:uppercase;">Main Match Pot Results</div>`;
            mainGameNet.forEach(item => {
                html += renderDebtRow(item, 'main');
            });
        }

        if (sideBetNet.length > 0) {
            html += `<div style="font-weight:700; color:var(--accent-cyan); font-size:0.82rem; text-transform:uppercase; margin-top:6px;">Player Side Bets</div>`;
            sideBetNet.forEach(item => {
                html += renderDebtRow(item, 'side');
            });
        }

        if (botBetNet.length > 0) {
            html += `<div style="font-weight:700; color:#a78bfa; font-size:0.82rem; text-transform:uppercase; margin-top:6px;">Bot Play Ledgers</div>`;
            botBetNet.forEach(item => {
                html += renderDebtRow(item, 'bot');
            });
        }

        html += `</div>`;
    }

    html += `
        <div style="margin-top:14px; display:flex; gap:8px; justify-content:flex-end;">
            <button onclick="window.exportLedgerSnapshot()" style="background:#0284c7; border-color:#38bdf8;">📸 Share / Save Snapshot</button>
        </div>
    `;

    contentBox.innerHTML = html;
};

function renderDebtRow(item, category) {
    const myName = (window.clientState?.username || localStorage.getItem('saved_username') || '').toLowerCase();
    const isMeDebtor = item.debtor.toLowerCase() === myName;
    const isMeCreditor = item.creditor.toLowerCase() === myName;

    let badgeColor = 'rgba(255,255,255,0.06)';
    if (isMeDebtor) badgeColor = 'rgba(239, 68, 68, 0.15)';
    if (isMeCreditor) badgeColor = 'rgba(16, 185, 129, 0.15)';

    return `
        <div style="display:flex; align-items:center; justify-content:space-between; background:${badgeColor}; border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:7px 10px; font-size:0.82rem;">
            <div>
                <span style="font-weight:700; color:#f87171;">${item.debtor}</span>
                <span style="color:var(--text-muted); margin:0 4px;">owes</span>
                <span style="font-weight:700; color:#34d399;">${item.creditor}</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-weight:800; font-size:0.95rem; color:var(--accent-gold);">$${item.amount}</span>
                ${isMeCreditor ? `<button onclick="window.clearDebtCategory('${item.debtor}', '${category}')" style="padding:2px 6px; font-size:0.7rem; background:#15803d; border-color:#22c55e;">Settle</button>` : ''}
            </div>
        </div>
    `;
}

window.renderLifetimeLedger = function(balances) {
    const modal = getLedgerModal();
    if (!modal) return;

    let contentBox = modal.querySelector('#ledger-modal-body') ||
                     modal.querySelector('.ledger-content-body') ||
                     modal.querySelector('.modal-content') ||
                     modal.querySelector('.modal-box');
    if (!contentBox) return;

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.15); padding-bottom:8px;">
            <div style="display:flex; gap:8px;">
                <button id="ledger-tab-session-btn" onclick="window.switchLedgerTab('session')" style="background:${window.activeLedgerTab === 'session' ? 'var(--accent-gold)' : 'rgba(255,255,255,0.1)'}; color:${window.activeLedgerTab === 'session' ? '#000' : '#fff'}; font-weight:700;">Current Session</button>
                <button id="ledger-tab-lifetime-btn" onclick="window.switchLedgerTab('lifetime')" style="background:${window.activeLedgerTab === 'lifetime' ? 'var(--accent-gold)' : 'rgba(255,255,255,0.1)'}; color:${window.activeLedgerTab === 'lifetime' ? '#000' : '#fff'}; font-weight:700;">Lifetime</button>
            </div>
            <button onclick="window.closeLedgerModal()" class="secondary" style="padding:4px 8px;">✕</button>
        </div>
    `;

    const balanceKeys = Object.keys(balances || {});
    if (balanceKeys.length === 0) {
        html += `<div style="text-align:center; padding:24px 0; color:var(--text-muted); font-size:0.9rem;">No lifetime records found. Log in with a registered account to view permanent records.</div>`;
    } else {
        html += `<div style="display:flex; flex-direction:column; gap:8px; max-height:55vh; overflow-y:auto; padding-right:4px;">`;
        balanceKeys.forEach(user => {
            const netVal = Number(balances[user]) || 0;
            const isOwed = netVal > 0;
            const isOwe = netVal < 0;

            html += `
                <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:7px 10px; font-size:0.84rem;">
                    <span style="font-weight:700;">${user}</span>
                    <span style="font-weight:800; font-size:0.92rem; color:${isOwed ? '#34d399' : (isOwe ? '#f87171' : 'var(--text-muted)')};">
                        ${isOwed ? `+ $${netVal}` : (isOwe ? `- $${Math.abs(netVal)}` : `$0`)}
                    </span>
                </div>
            `;
        });
        html += `</div>`;
    }

    contentBox.innerHTML = html;
};

// -------------------------------------------------------------
// 4. CANVAS SNAPSHOT GENERATION & SHARING
// -------------------------------------------------------------
window.exportLedgerSnapshot = function() {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 700;
    const ctx = canvas.getContext('2d');

    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, 0, 700);
    grad.addColorStop(0, '#07130e');
    grad.addColorStop(1, '#0f291e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 600, 700);

    // Gold border frame
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 4;
    ctx.strokeRect(10, 10, 580, 680);

    // Title header
    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 26px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BLITZ 31 - SESSION LEDGER', 300, 55);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.fillText(new Date().toLocaleString(), 300, 85);

    // Line divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 105);
    ctx.lineTo(570, 105);
    ctx.stroke();

    const lobby = window.appGlobals?.latestLobbySnapshot || {};
    const mainNet = window.calculatePairwiseNet(lobby.mainGameLedger || {});
    const sideNet = window.calculatePairwiseNet(lobby.sideBetLedger || {});
    const allDebts = [...mainNet, ...sideNet];

    let y = 145;
    ctx.textAlign = 'left';

    if (allDebts.length === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '18px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('All players are even. Zero session debts.', 300, 320);
    } else {
        allDebts.slice(0, 12).forEach(item => {
            ctx.fillStyle = '#f87171';
            ctx.font = 'bold 16px -apple-system, sans-serif';
            ctx.fillText(item.debtor, 50, y);

            ctx.fillStyle = '#94a3b8';
            ctx.font = '14px -apple-system, sans-serif';
            ctx.fillText('owes', 210, y);

            ctx.fillStyle = '#34d399';
            ctx.font = 'bold 16px -apple-system, sans-serif';
            ctx.fillText(item.creditor, 260, y);

            ctx.fillStyle = '#f59e0b';
            ctx.font = 'bold 18px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`$${item.amount}`, 550, y);

            ctx.textAlign = 'left';
            y += 40;
        });
    }

    // Share or download
    canvas.toBlob(blob => {
        if (!blob) return;
        const file = new File([blob], 'blitz31-ledger.png', { type: 'image/png' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            navigator.share({
                files: [file],
                title: 'Blitz 31 Ledger',
                text: 'Settlement summary for Blitz 31 session.'
            }).catch(() => {});
        } else {
            const link = document.createElement('a');
            link.download = 'blitz31-ledger.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
        }
    }, 'image/png');
};
