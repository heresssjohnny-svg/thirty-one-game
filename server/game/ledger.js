// public/js/ledger.js - Session Ledger, Lifetime Records & Snapshot Capture

// --- 1. Pairwise Debt Calculation Engine ---
window.calculatePairwiseNet = function(ledgerData, myName, allUsers) {
    let totalNet = 0;
    const records = {};
    const cleanMe = (myName || '').trim().toLowerCase();
    const ledgerKeys = new Set([...(allUsers || [])]);

    if (ledgerData && typeof ledgerData === 'object') {
        for (const dKey in ledgerData) {
            ledgerKeys.add(dKey);
            if (ledgerData[dKey] && typeof ledgerData[dKey] === 'object') {
                for (const cKey in ledgerData[dKey]) {
                    ledgerKeys.add(cKey);
                }
            }
        }
    }

    ledgerKeys.forEach((otherUser) => {
        const cleanOther = (otherUser || '').trim();
        if (!cleanOther || cleanOther.toLowerCase() === cleanMe) return;

        let theyOweMe = 0;
        let iOweThem = 0;

        if (ledgerData && typeof ledgerData === 'object') {
            for (const dKey in ledgerData) {
                if (dKey.trim().toLowerCase() === cleanOther.toLowerCase()) {
                    for (const cKey in ledgerData[dKey]) {
                        if (cKey.trim().toLowerCase() === cleanMe) {
                            theyOweMe += Number(ledgerData[dKey][cKey]) || 0;
                        }
                    }
                }
                if (dKey.trim().toLowerCase() === cleanMe) {
                    for (const cKey in ledgerData[dKey]) {
                        if (cKey.trim().toLowerCase() === cleanOther.toLowerCase()) {
                            iOweThem += Number(ledgerData[dKey][cKey]) || 0;
                        }
                    }
                }
            }
        }

        const net = theyOweMe - iOweThem;
        if (net !== 0) {
            records[cleanOther] = net;
            totalNet += net;
        }
    });

    return { totalNet, records };
};

// --- 2. In-Game Session Ledger Modal ---
window.openLedgerModal = function() {
    const modal = document.getElementById('ledger-modal');
    const ledgerDiv = document.getElementById('ledger-content');
    if (modal) modal.style.display = 'flex';
    if (!ledgerDiv) return;

    const myName = (
        document.getElementById('username-input')?.value ||
        (window.userSession && window.userSession.username) ||
        window.clientState?.username ||
        'Player1'
    ).trim();

    const sideLedgerData = window.clientState?.sideBetLedger || {};
    const mainLedgerData = window.clientState?.mainGameLedger || {};
    const botBetLedgerData = window.clientState?.botBetLedger || {};

    const allUsers = new Set([
        ...Object.keys(sideLedgerData),
        ...Object.keys(mainLedgerData),
        ...Object.keys(botBetLedgerData),
        ...(window.clientState?.playersList || [])
    ]);

    const sideCalc = window.calculatePairwiseNet(sideLedgerData, myName, allUsers);
    const mainCalc = window.calculatePairwiseNet(mainLedgerData, myName, allUsers);
    const botCalc = window.calculatePairwiseNet(botBetLedgerData, myName, allUsers);
    const grandTotal = sideCalc.totalNet + mainCalc.totalNet;

    let html = `
        <div style="font-size: 0.9rem; font-weight: bold; margin-bottom: 5px; color: ${grandTotal >= 0 ? '#34d399' : '#f87171'};">
            Total Net Balance: $${grandTotal.toFixed(2)}
        </div>
        <hr style="border-color:#475569; margin-bottom:5px;">
    `;

    // Side Bets Section
    html += `<div style="font-size: 0.75rem; font-weight: bold; color: var(--accent-gold); margin-bottom: 2px;">🤝 Side Bets</div>`;
    const sideEntries = Object.entries(sideCalc.records);
    if (sideEntries.length === 0) {
        html += `<div style="font-size: 0.65rem; color: var(--text-muted); margin-left: 8px; margin-bottom: 5px;">No side bet balances.</div>`;
    } else {
        html += '<ul style="margin-bottom: 5px; padding-left: 14px;">';
        for (const [user, netAmt] of sideEntries) {
            const relationText = netAmt > 0
                ? `<span style="color:#34d399;">owes you $${Math.abs(netAmt).toFixed(2)}</span>`
                : `<span style="color:#f87171;">you owe $${Math.abs(netAmt).toFixed(2)}</span>`;
            const clearBtn = netAmt > 0
                ? ` <button style="font-size:0.55rem; padding:1px 4px; background:#10b981; border:none; border-radius:3px; color:#fff; cursor:pointer;" onclick="clearDebtCategory('${user}', 'side')">Clear</button>`
                : '';
            html += `<li style="margin-bottom:2px; font-size:0.75rem;"><b>${user}</b> ${relationText}${clearBtn}</li>`;
        }
        html += '</ul>';
    }

    // Main Game Pot Ledger Section
    html += `<div style="font-size: 0.75rem; font-weight: bold; color: var(--accent-gold); margin-bottom: 2px;">🎮 Main Game Pot Ledger</div>`;
    const mainEntries = Object.entries(mainCalc.records);
    if (mainEntries.length === 0) {
        html += `<div style="font-size: 0.65rem; color: var(--text-muted); margin-left: 8px;">No main game balances recorded yet.</div>`;
    } else {
        html += '<ul style="margin-bottom: 5px; padding-left: 14px;">';
        for (const [user, netAmt] of mainEntries) {
            const relationText = netAmt > 0
                ? `<span style="color:#34d399;">owes you $${Math.abs(netAmt).toFixed(2)}</span>`
                : `<span style="color:#f87171;">you owe $${Math.abs(netAmt).toFixed(2)}</span>`;
            const clearBtn = netAmt > 0
                ? ` <button style="font-size:0.55rem; padding:1px 4px; background:#10b981; border:none; border-radius:3px; color:#fff; cursor:pointer;" onclick="clearDebtCategory('${user}', 'main')">Clear</button>`
                : '';
            html += `<li style="margin-bottom:2px; font-size:0.75rem;"><b>${user}</b> ${relationText}${clearBtn}</li>`;
        }
        html += '</ul>';
    }

    // Bot Bets Section
    html += `<div style="font-size: 0.75rem; font-weight: bold; color: var(--accent-cyan); margin-top: 6px; margin-bottom: 2px;">🤖 Bot Bets (Excluded from Total Net)</div>`;
    const botEntries = Object.entries(botCalc.records);
    if (botEntries.length === 0) {
        html += `<div style="font-size: 0.65rem; color: var(--text-muted); margin-left: 8px;">No bot bets recorded.</div>`;
    } else {
        html += '<ul style="margin-bottom: 5px; padding-left: 14px;">';
        for (const [user, netAmt] of botEntries) {
            const relationText = netAmt > 0
                ? `<span style="color:#34d399;">owes you $${Math.abs(netAmt).toFixed(2)}</span>`
                : `<span style="color:#f87171;">you owe $${Math.abs(netAmt).toFixed(2)}</span>`;
            const clearBtn = netAmt > 0
                ? ` <button style="font-size:0.55rem; padding:1px 4px; background:#10b981; border:none; border-radius:3px; color:#fff; cursor:pointer;" onclick="clearDebtCategory('${user}', 'bot')">Clear</button>`
                : '';
            html += `<li style="margin-bottom:2px; font-size:0.75rem;"><b>${user}</b> ${relationText}${clearBtn}</li>`;
        }
        html += '</ul>';
    }

    ledgerDiv.innerHTML = html;
};

window.clearDebtCategory = function(targetUser, category) {
    const sendFn = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFn === 'function') {
        sendFn({ type: 'CLEAR_DEBT', targetUser, category });
    }
    setTimeout(() => window.openLedgerModal(), 200);
};

// --- 3. Lifetime SQLite Ledger Modal ---
window.openLifetimeLedgerModal = function() {
    const modal = document.getElementById('lifetime-ledger-modal');
    if (modal) modal.style.display = 'flex';

    const sendFn = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFn === 'function') {
        sendFn({ type: 'GET_LIFETIME_LEDGER' });
    }
};

window.renderLifetimeLedger = function(data) {
    const container = document.getElementById('lifetime-ledger-content');
    if (!container) return;

    if (!data || (!data.iOwe?.length && !data.owesMe?.length)) {
        container.innerHTML = '<div style="color:var(--text-muted); padding:8px; text-align:center;">No all-time balances recorded.</div>';
        return;
    }

    let html = '';
    if (data.owesMe && data.owesMe.length > 0) {
        html += `<div style="font-weight:bold; color:#34d399; margin-bottom:4px;">People Who Owe You:</div><ul style="padding-left:14px; margin-bottom:8px;">`;
        data.owesMe.forEach(row => {
            html += `<li><b>${row.otherUser}</b> owes you $${Number(row.amount).toFixed(2)}</li>`;
        });
        html += '</ul>';
    }

    if (data.iOwe && data.iOwe.length > 0) {
        html += `<div style="font-weight:bold; color:#f87171; margin-bottom:4px;">People You Owe:</div><ul style="padding-left:14px; margin-bottom:8px;">`;
        data.iOwe.forEach(row => {
            html += `<li>You owe <b>${row.otherUser}</b> $${Number(row.amount).toFixed(2)}</li>`;
        });
        html += '</ul>';
    }

    container.innerHTML = html;
};

// --- 4. Canvas Snapshot Exporter ---
window.saveLedgerScreenshot = function() {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 500;
    const ctx = canvas.getContext('2d');

    // Canvas Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Decorative Border
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 4;
    ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

    // Header
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('31! Table Ledger Snapshot', canvas.width / 2, 45);

    // Timestamp
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px sans-serif';
    const timeStr = new Date().toLocaleString();
    ctx.fillText(timeStr, canvas.width / 2, 70);

    // Divider
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 85);
    ctx.lineTo(370, 85);
    ctx.stroke();

    // Data Parsing
    const myName = (
        document.getElementById('username-input')?.value ||
        (window.userSession && window.userSession.username) ||
        window.clientState?.username ||
        'Player1'
    ).trim();

    const sideLedgerData = window.clientState?.sideBetLedger || {};
    const mainLedgerData = window.clientState?.mainGameLedger || {};
    const allUsers = new Set([
        ...Object.keys(sideLedgerData),
        ...Object.keys(mainLedgerData),
        ...(window.clientState?.playersList || [])
    ]);

    const sideCalc = window.calculatePairwiseNet(sideLedgerData, myName, allUsers);
    const mainCalc = window.calculatePairwiseNet(mainLedgerData, myName, allUsers);
    const grandTotal = sideCalc.totalNet + mainCalc.totalNet;

    ctx.textAlign = 'left';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = grandTotal >= 0 ? '#34d399' : '#f87171';
    ctx.fillText(`Net Total: $${grandTotal.toFixed(2)}`, 30, 115);

    let y = 145;
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('Side Bets:', 30, y);
    y += 20;

    ctx.font = '12px sans-serif';
    const sideEntries = Object.entries(sideCalc.records);
    if (sideEntries.length === 0) {
        ctx.fillStyle = '#64748b';
        ctx.fillText('No side bet balances', 45, y);
        y += 20;
    } else {
        sideEntries.forEach(([user, amt]) => {
            ctx.fillStyle = amt > 0 ? '#34d399' : '#f87171';
            const text = amt > 0 ? `${user} owes you $${amt.toFixed(2)}` : `You owe ${user} $${Math.abs(amt).toFixed(2)}`;
            ctx.fillText(text, 45, y);
            y += 20;
        });
    }

    y += 10;
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('Main Table Pot:', 30, y);
    y += 20;

    ctx.font = '12px sans-serif';
    const mainEntries = Object.entries(mainCalc.records);
    if (mainEntries.length === 0) {
        ctx.fillStyle = '#64748b';
        ctx.fillText('No main game balances', 45, y);
        y += 20;
    } else {
        mainEntries.forEach(([user, amt]) => {
            ctx.fillStyle = amt > 0 ? '#34d399' : '#f87171';
            const text = amt > 0 ? `${user} owes you $${amt.toFixed(2)}` : `You owe ${user} $${Math.abs(amt).toFixed(2)}`;
            ctx.fillText(text, 45, y);
            y += 20;
        });
    }

    // Export: Mobile Native Share Sheet with Desktop Fallback
    canvas.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], `31-ledger-${Date.now()}.png`, { type: 'image/png' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            navigator.share({
                files: [file],
                title: '31! Game Ledger',
                text: `Ledger Snapshot from ${timeStr}`
            }).catch(() => {});
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `31-ledger-${Date.now()}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
    }, 'image/png');
};
