// public/js/ledger.js
function calculatePairwiseNet(ledgerData, myName, allUsers) {
    let totalNet = 0;
    const records = {};
    const ledgerKeys = new Set([...Object.keys(ledgerData || {}), ...allUsers]);
    
    for (const debtorKey in ledgerData) {
        ledgerKeys.add(debtorKey);
        if (ledgerData[debtorKey] && typeof ledgerData[debtorKey] === 'object') {
            for (const creditorKey in ledgerData[debtorKey]) {
                ledgerKeys.add(creditorKey);
            }
        }
    }

    ledgerKeys.forEach(otherUser => {
        if (otherUser === myName) return;
        const theyOweMe = (ledgerData[otherUser] && ledgerData[otherUser][myName]) || 0;
        const iOweThem = (ledgerData[myName] && ledgerData[myName][otherUser]) || 0;
        const net = theyOweMe - iOweThem;
        if (net !== 0) {
            records[otherUser] = net;
            totalNet += net;
        }
    });

    return { totalNet, records };
}

function openLedgerModal() {
    const ledgerDiv = document.getElementById('ledger-content');
    const myName = document.getElementById('username-input').value.trim() || window.clientState.username;
    
    const sideLedgerData = window.clientState.sideBetLedger || {};
    const mainLedgerData = window.clientState.mainGameLedger || {};
    const botBetLedgerData = window.clientState.botBetLedger || {};

    const allUsers = new Set([
        ...Object.keys(sideLedgerData), 
        ...Object.keys(mainLedgerData), 
        ...Object.keys(botBetLedgerData), 
        ...(window.clientState.playersList || [])
    ]);

    const sideCalc = calculatePairwiseNet(sideLedgerData, myName, allUsers);
    const mainCalc = calculatePairwiseNet(mainLedgerData, myName, allUsers);
    const botCalc = calculatePairwiseNet(botBetLedgerData, myName, allUsers);

    const grandTotal = sideCalc.totalNet + mainCalc.totalNet;

    let html = `<div style="font-size: 0.9rem; font-weight: bold; margin-bottom: 5px; color: ${grandTotal >= 0 ? '#34d399' : '#f87171'};">Total Net Balance: $${grandTotal.toFixed(2)}</div>`;
    html += `<hr style="border-color:#475569; margin-bottom:5px;">`;

    html += `<div style="font-size: 0.75rem; font-weight: bold; color: var(--accent-gold); margin-bottom: 2px;">🤝 Side Bets</div>`;
    let hasSideEntries = false;
    let sideHtml = '<ul style="margin-bottom: 5px;">';
    for (const [user, netAmt] of Object.entries(sideCalc.records)) {
        hasSideEntries = true;
        const relationText = netAmt > 0 ? `<span style="color:#34d399;">owes you $${Math.abs(netAmt).toFixed(2)}</span>` : `<span style="color:#f87171;">you owe $${Math.abs(netAmt).toFixed(2)}</span>`;
        const clearBtn = netAmt > 0 ? ` <button style="font-size:0.5rem; padding:1px 3px; background:#10b981;" onclick="clearDebtCategory('${user}', 'side')">Clear</button>` : '';
        sideHtml += `<li style="margin-left: 8px; margin-bottom:2px;"><b>${user}</b> ${relationText}${clearBtn}</li>`;
    }
    sideHtml += '</ul>';
    html += hasSideEntries ? sideHtml : `<div style="font-size: 0.65rem; color: var(--text-muted); margin-left: 8px; margin-bottom: 5px;">No side bet balances.</div>`;

    html += `<div style="font-size: 0.75rem; font-weight: bold; color: var(--accent-gold); margin-bottom: 2px;">🎮 Main Game Pot Ledger</div>`;
    let hasMainEntries = false;
    let mainHtml = '<ul>';
    for (const [user, netAmt] of Object.entries(mainCalc.records)) {
        hasMainEntries = true;
        const relationText = netAmt > 0 ? `<span style="color:#34d399;">owes you $${Math.abs(netAmt).toFixed(2)}</span>` : `<span style="color:#f87171;">you owe $${Math.abs(netAmt).toFixed(2)}</span>`;
        const clearBtn = netAmt > 0 ? ` <button style="font-size:0.5rem; padding:1px 3px; background:#10b981;" onclick="clearDebtCategory('${user}', 'main')">Clear</button>` : '';
        mainHtml += `<li style="margin-left: 8px; margin-bottom:2px;"><b>${user}</b> ${relationText}${clearBtn}</li>`;
    }
    mainHtml += '</ul>';
    html += hasMainEntries ? mainHtml : `<div style="font-size: 0.65rem; color: var(--text-muted); margin-left: 8px;">No main game balances recorded yet.</div>`;

    html += `<div style="font-size: 0.75rem; font-weight: bold; color: var(--accent-cyan); margin-top: 6px; margin-bottom: 2px;">🤖 Bot Bets (Excluded from Total Net)</div>`;
    let hasBotEntries = false;
    let botHtml = '<ul>';
    for (const [user, netAmt] of Object.entries(botCalc.records)) {
        hasBotEntries = true;
        const relationText = netAmt > 0 ? `<span style="color:#34d399;">owes you $${Math.abs(netAmt).toFixed(2)}</span>` : `<span style="color:#f87171;">you owe $${Math.abs(netAmt).toFixed(2)}</span>`;
        const clearBtn = netAmt > 0 ? ` <button style="font-size:0.5rem; padding:1px 3px; background:#10b981;" onclick="clearDebtCategory('${user}', 'bot')">Clear</button>` : '';
        botHtml += `<li style="margin-left: 8px; margin-bottom:2px;"><b>${user}</b> ${relationText}${clearBtn}</li>`;
    }
    botHtml += '</ul>';
    html += hasBotEntries ? botHtml : `<div style="font-size: 0.65rem; color: var(--text-muted); margin-left: 8px;">No bot bets recorded.</div>`;

    ledgerDiv.innerHTML = html;
    toggleModal('ledger-modal');
}

function clearDebtCategory(targetUser, category) {
    initSocketAndSend({ type: 'CLEAR_DEBT', targetUser, category });
    setTimeout(() => openLedgerModal(), 200);
}

function saveLedgerScreenshot() {
    const myName = document.getElementById('username-input').value.trim() || window.clientState.username;
    const sideLedgerData = window.clientState.sideBetLedger || {};
    const mainLedgerData = window.clientState.mainGameLedger || {};
    const botLedgerData = window.clientState.botBetLedger || {};

    const allUsers = new Set([
        ...Object.keys(sideLedgerData), 
        ...Object.keys(mainLedgerData), 
        ...Object.keys(botLedgerData), 
        ...(window.clientState.playersList || [])
    ]);

    const sideCalc = calculatePairwiseNet(sideLedgerData, myName, allUsers);
    const mainCalc = calculatePairwiseNet(mainLedgerData, myName, allUsers);
    const botCalc = calculatePairwiseNet(botLedgerData, myName, allUsers);
    const grandTotal = sideCalc.totalNet + mainCalc.totalNet;

    const now = new Date();
    const dateStr = now.toLocaleDateString();
    const timeStr = now.toLocaleTimeString();
    const pad = (n) => String(n).padStart(2, '0');
    const timestampFile = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    const lines = [];
    lines.push({ text: `Total Net Balance: $${grandTotal.toFixed(2)}`, font: 'bold 22px system-ui', color: grandTotal >= 0 ? '#34d399' : '#f87171' });
    lines.push({ type: 'divider' });

    lines.push({ text: '🤝 Side Bets', font: 'bold 18px system-ui', color: '#facc15' });
    const sideKeys = Object.entries(sideCalc.records);
    if (sideKeys.length === 0) {
        lines.push({ text: '  No side bet balances.', font: '14px system-ui', color: '#94a3b8' });
    } else {
        for (const [user, netAmt] of sideKeys) {
            const rel = netAmt > 0 ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`;
            lines.push({ text: `  • ${user}: ${rel}`, font: '15px system-ui', color: netAmt > 0 ? '#34d399' : '#f87171' });
        }
    }

    lines.push({ type: 'spacer' });
    lines.push({ text: '🎮 Main Game Pot Ledger', font: 'bold 18px system-ui', color: '#facc15' });
    const mainKeys = Object.entries(mainCalc.records);
    if (mainKeys.length === 0) {
        lines.push({ text: '  No main game balances recorded.', font: '14px system-ui', color: '#94a3b8' });
    } else {
        for (const [user, netAmt] of mainKeys) {
            const rel = netAmt > 0 ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`;
            lines.push({ text: `  • ${user}: ${rel}`, font: '15px system-ui', color: netAmt > 0 ? '#34d399' : '#f87171' });
        }
    }

    lines.push({ type: 'spacer' });
    lines.push({ text: '🤖 Bot Bets (Excluded from Total Net)', font: 'bold 18px system-ui', color: '#38bdf8' });
    const botKeys = Object.entries(botCalc.records);
    if (botKeys.length === 0) {
        lines.push({ text: '  No bot bets recorded.', font: '14px system-ui', color: '#94a3b8' });
    } else {
        for (const [user, netAmt] of botKeys) {
            const rel = netAmt > 0 ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`;
            lines.push({ text: `  • ${user}: ${rel}`, font: '15px system-ui', color: netAmt > 0 ? '#34d399' : '#f87171' });
        }
    }

    const width = 640;
    const headerHeight = 110;
    let contentHeight = 0;
    lines.forEach(l => {
        if (l.type === 'divider' || l.type === 'spacer') contentHeight += 18;
        else contentHeight += 26;
    });
    const height = headerHeight + contentHeight + 40;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#022c22';
    ctx.fillRect(0, 0, width, height);

    const grad = ctx.createRadialGradient(width / 2, height / 2, 50, width / 2, height / 2, width);
    grad.addColorStop(0, '#065f46');
    grad.addColorStop(1, '#044e36');
    ctx.fillStyle = grad;
    ctx.fillRect(10, 10, width - 20, height - 20);

    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 3;
    ctx.strokeRect(10, 10, width - 20, height - 20);

    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 26px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('31! Card Game — Ledger Snapshot', width / 2, 48);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '14px system-ui';
    ctx.fillText(`Player: ${myName}  |  Timestamp: ${dateStr} ${timeStr}`, width / 2, 75);

    ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 95);
    ctx.lineTo(width - 30, 95);
    ctx.stroke();

    ctx.textAlign = 'left';
    let currY = 130;
    lines.forEach(l => {
        if (l.type === 'divider') {
            ctx.strokeStyle = '#334155';
            ctx.beginPath();
            ctx.moveTo(30, currY - 8);
            ctx.lineTo(width - 30, currY - 8);
            ctx.stroke();
            currY += 16;
        } else if (l.type === 'spacer') {
            currY += 16;
        } else {
            ctx.fillStyle = l.color;
            ctx.font = l.font;
            ctx.fillText(l.text, 35, currY);
            currY += 26;
        }
    });

    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `31_Ledger_${timestampFile}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showCenterNotification(`📸 Snapshot saved: 31_Ledger_${timestampFile}.png`);
    }, 'image/png');

    toggleModal('ledger-modal');
}

