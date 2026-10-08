// public/js/ledger.js - Session Ledger, Pairwise Math, Lifetime Balances & Canvas Exporter

let activeScreenshotBlobUrl = null;

// -------------------------------------------------------------
// 1. PAIRWISE BALANCE CALCULATION ENGINE
// -------------------------------------------------------------
/**
 * Accurately calculates pairwise net balances between current user and all opponents.
 * Positive net = other player owes current user money.
 * Negative net = current user owes other player money.
 */
window.calculatePairwiseNet = function(ledgerData, myName, allUsers) {
    let totalNet = 0;
    const records = {};
    const cleanMe = (myName || '').trim().toLowerCase();

    // Collect all unique participant keys
    const ledgerKeys = new Set([...(allUsers || [])]);
    if (ledgerData && typeof ledgerData === 'object') {
        for (const debtorKey in ledgerData) {
            ledgerKeys.add(debtorKey);
            if (ledgerData[debtorKey] && typeof ledgerData[debtorKey] === 'object') {
                for (const creditorKey in ledgerData[debtorKey]) {
                    ledgerKeys.add(creditorKey);
                }
            }
        }
    }

    ledgerKeys.forEach((otherUser) => {
        const cleanOther = (otherUser || '').trim();
        if (!cleanOther || cleanOther.toLowerCase() === cleanMe) return;

        // Find exact debtor/creditor balances regardless of casing
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

// -------------------------------------------------------------
// 2. ACTIVE SESSION TABLE LEDGER MODAL
// -------------------------------------------------------------
window.openLedgerModal = function() {
    const ledgerDiv = document.getElementById('ledger-content');
    if (!ledgerDiv) return;

    const usernameInput = document.getElementById('username-input');
    const myName = (usernameInput && usernameInput.value ? usernameInput.value : (window.clientState?.username || 'Player1')).trim();

    const sideLedgerData = window.clientState?.sideBetLedger || {};
    const mainLedgerData = window.clientState?.mainGameLedger || {};
    const botLedgerData = window.clientState?.botBetLedger || {};

    const allUsers = new Set([
        ...Object.keys(sideLedgerData),
        ...Object.keys(mainLedgerData),
        ...Object.keys(botLedgerData),
        ...(window.clientState?.playersList || [])
    ]);

    const sideCalc = window.calculatePairwiseNet(sideLedgerData, myName, allUsers);
    const mainCalc = window.calculatePairwiseNet(mainLedgerData, myName, allUsers);
    const botCalc = window.calculatePairwiseNet(botLedgerData, myName, allUsers);
    const grandTotal = sideCalc.totalNet + mainCalc.totalNet;

    let html = `
        <div style="font-size:0.95rem; font-weight:bold; margin-bottom:6px; color:${grandTotal >= 0 ? '#34d399' : '#f87171'};">
            Total Net Balance: $${grandTotal.toFixed(2)}
        </div>
        <hr style="border-color:#334155; margin-bottom:8px;">
    `;

    // 1. Side Bets Section
    html += `<div style="font-size:0.75rem; font-weight:bold; color:var(--accent-gold); margin-bottom:3px;">🤝 Side Bets</div>`;
    const sideEntries = Object.entries(sideCalc.records);
    if (sideEntries.length === 0) {
        html += `<div style="font-size:0.7rem; color:var(--text-muted); margin-left:8px; margin-bottom:6px;">No side bet balances.</div>`;
    } else {
        html += '<ul style="list-style:none; padding:0; margin:0 0 6px 8px;">';
        sideEntries.forEach(([user, netAmt]) => {
            const owesMe = netAmt > 0;
            const clearBtn = owesMe ? ` <button style="font-size:0.6rem; padding:1px 5px; background:#10b981; margin-left:4px;" onclick="clearDebtCategory('${user}', 'side')">Clear</button>` : '';
            html += `
                <li style="margin-bottom:3px; font-size:0.75rem;">
                    <b>${user}</b>: 
                    <span style="color:${owesMe ? '#34d399' : '#f87171'}; font-weight:bold;">
                        ${owesMe ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`}
                    </span>${clearBtn}
                </li>
            `;
        });
        html += '</ul>';
    }

    // 2. Main Game Pot Ledger Section
    html += `<div style="font-size:0.75rem; font-weight:bold; color:var(--accent-gold); margin-bottom:3px;">🎮 Main Game Pot Ledger</div>`;
    const mainEntries = Object.entries(mainCalc.records);
    if (mainEntries.length === 0) {
        html += `<div style="font-size:0.7rem; color:var(--text-muted); margin-left:8px; margin-bottom:6px;">No main game balances recorded.</div>`;
    } else {
        html += '<ul style="list-style:none; padding:0; margin:0 0 6px 8px;">';
        mainEntries.forEach(([user, netAmt]) => {
            const owesMe = netAmt > 0;
            const clearBtn = owesMe ? ` <button style="font-size:0.6rem; padding:1px 5px; background:#10b981; margin-left:4px;" onclick="clearDebtCategory('${user}', 'main')">Clear</button>` : '';
            html += `
                <li style="margin-bottom:3px; font-size:0.75rem;">
                    <b>${user}</b>: 
                    <span style="color:${owesMe ? '#34d399' : '#f87171'}; font-weight:bold;">
                        ${owesMe ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`}
                    </span>${clearBtn}
                </li>
            `;
        });
        html += '</ul>';
    }

    // 3. Bot Bets Section
    html += `<div style="font-size:0.75rem; font-weight:bold; color:var(--accent-cyan); margin-bottom:3px;">🤖 Bot Bets</div>`;
    const botEntries = Object.entries(botCalc.records);
    if (botEntries.length === 0) {
        html += `<div style="font-size:0.7rem; color:var(--text-muted); margin-left:8px;">No bot bets recorded.</div>`;
    } else {
        html += '<ul style="list-style:none; padding:0; margin:0 0 4px 8px;">';
        botEntries.forEach(([user, netAmt]) => {
            const owesMe = netAmt > 0;
            const clearBtn = owesMe ? ` <button style="font-size:0.6rem; padding:1px 5px; background:#10b981; margin-left:4px;" onclick="clearDebtCategory('${user}', 'bot')">Clear</button>` : '';
            html += `
                <li style="margin-bottom:3px; font-size:0.75rem;">
                    <b>${user}</b>: 
                    <span style="color:${owesMe ? '#34d399' : '#f87171'}; font-weight:bold;">
                        ${owesMe ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`}
                    </span>${clearBtn}
                </li>
            `;
        });
        html += '</ul>';
    }

    ledgerDiv.innerHTML = html;
    if (typeof window.toggleModal === 'function') {
        window.toggleModal('ledger-modal');
    } else {
        const m = document.getElementById('ledger-modal');
        if (m) m.style.display = 'flex';
    }
};

window.clearDebtCategory = function(targetUser, category) {
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') {
        sendFunc({
            type: 'CLEAR_DEBT',
            targetUser: targetUser,
            category: category
        });
    }
    setTimeout(() => {
        const ledgerModal = document.getElementById('ledger-modal');
        if (ledgerModal && ledgerModal.style.display === 'flex') {
            window.openLedgerModal();
        }
    }, 250);
};

// -------------------------------------------------------------
// 3. CANVAS SNAPSHOT GENERATION & ANDROID EXPORT
// -------------------------------------------------------------
function dataURLToBlobSync(dataURL) {
    const parts = dataURL.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const binary = atob(parts[1]);
    const len = binary.length;
    const u8arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        u8arr[i] = binary.charCodeAt(i);
    }
    return new Blob([u8arr], { type: mime });
}

window.closeScreenshotModal = function() {
    const modal = document.getElementById('screenshot-modal');
    if (modal) modal.style.display = 'none';
    if (activeScreenshotBlobUrl) {
        URL.revokeObjectURL(activeScreenshotBlobUrl);
        activeScreenshotBlobUrl = null;
    }
};

window.saveLedgerScreenshot = function() {
    const ledgerModal = document.getElementById('ledger-modal');
    if (ledgerModal) ledgerModal.style.display = 'none';

    const usernameInput = document.getElementById('username-input');
    const myName = (usernameInput && usernameInput.value ? usernameInput.value : (window.clientState?.username || 'Player1')).trim();

    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `31-ledger-${dateStr}.png`;
    const readableDate = now.toLocaleString();

    // Render Canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 600;
    canvas.height = 760;

    // Dark Casino Felt Background & Border
    ctx.fillStyle = '#065f46';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

    // Title & Metadata
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillText("31! Game Ledger Snapshot", 30, 50);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText(`Player: ${myName}  |  Captured: ${readableDate}`, 30, 80);

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 95);
    ctx.lineTo(570, 95);
    ctx.stroke();

    // Calculate Balances
    const sideCalc = window.calculatePairwiseNet(window.clientState?.sideBetLedger || {}, myName, window.clientState?.playersList || []);
    const mainCalc = window.calculatePairwiseNet(window.clientState?.mainGameLedger || {}, myName, window.clientState?.playersList || []);
    const botCalc = window.calculatePairwiseNet(window.clientState?.botBetLedger || {}, myName, window.clientState?.playersList || []);
    const grandTotal = sideCalc.totalNet + mainCalc.totalNet;

    // Net Balance Header
    ctx.fillStyle = grandTotal >= 0 ? '#34d399' : '#f87171';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText(`Total Net Balance: $${grandTotal.toFixed(2)}`, 30, 130);

    let y = 170;

    // 1. Side Bets Draw
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.fillText("🤝 Side Bets", 30, y);
    y += 25;

    ctx.font = '15px system-ui, sans-serif';
    const sideEntries = Object.entries(sideCalc.records);
    if (sideEntries.length === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText("No active side bet balances.", 45, y);
        y += 25;
    } else {
        sideEntries.forEach(([user, netAmt]) => {
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(`• ${user}: `, 45, y);
            ctx.fillStyle = netAmt > 0 ? '#34d399' : '#f87171';
            ctx.fillText(netAmt > 0 ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`, 160, y);
            y += 25;
        });
    }

    y += 15;

    // 2. Main Game Pot Draw
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.fillText("🎮 Main Game Pot Ledger", 30, y);
    y += 25;

    ctx.font = '15px system-ui, sans-serif';
    const mainEntries = Object.entries(mainCalc.records);
    if (mainEntries.length === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText("No main game balances recorded.", 45, y);
        y += 25;
    } else {
        mainEntries.forEach(([user, netAmt]) => {
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(`• ${user}: `, 45, y);
            ctx.fillStyle = netAmt > 0 ? '#34d399' : '#f87171';
            ctx.fillText(netAmt > 0 ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`, 160, y);
            y += 25;
        });
    }

    y += 15;

    // 3. Bot Bets Draw
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.fillText("🤖 Bot Bets Ledger", 30, y);
    y += 25;

    ctx.font = '15px system-ui, sans-serif';
    const botEntries = Object.entries(botCalc.records);
    if (botEntries.length === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText("No bot bet balances recorded.", 45, y);
    } else {
        botEntries.forEach(([user, netAmt]) => {
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(`• ${user}: `, 45, y);
            ctx.fillStyle = netAmt > 0 ? '#34d399' : '#f87171';
            ctx.fillText(netAmt > 0 ? `owes you $${Math.abs(netAmt).toFixed(2)}` : `you owe $${Math.abs(netAmt).toFixed(2)}`, 160, y);
            y += 25;
        });
    }

    // Convert Canvas to Binary Blob & File
    const dataUrl = canvas.toDataURL('image/png');
    const blob = dataURLToBlobSync(dataUrl);
    if (activeScreenshotBlobUrl) URL.revokeObjectURL(activeScreenshotBlobUrl);
    activeScreenshotBlobUrl = URL.createObjectURL(blob);
    const file = new File([blob], fileName, { type: 'image/png' });

    // Populate Snapshot Modal
    const modal = document.getElementById('screenshot-modal');
    const img = document.getElementById('screenshot-preview-img');
    const shareBtn = document.getElementById('screenshot-share-btn');
    const dlLink = document.getElementById('screenshot-download-link');
    const statusText = document.getElementById('screenshot-status-text');

    if (img) img.src = dataUrl;
    if (statusText) statusText.innerText = '';

    if (dlLink) {
        dlLink.href = activeScreenshotBlobUrl;
        dlLink.download = fileName;
        dlLink.onclick = () => {
            if (statusText) statusText.innerText = 'Download initiated!';
        };
    }

    if (shareBtn) {
        shareBtn.onclick = async () => {
            if (statusText) statusText.innerText = 'Opening share sheet...';

            // 1. Native Capacitor Share (Android APK)
            if (window.Capacitor?.Plugins?.Share) {
                try {
                    await window.Capacitor.Plugins.Share.share({
                        title: '31! Game Ledger',
                        url: dataUrl,
                        dialogTitle: 'Save Ledger Snapshot'
                    });
                    if (statusText) statusText.innerText = 'System sheet opened.';
                    return;
                } catch (e) {}
            }

            // 2. Web Share API with File payload
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: '31! Game Ledger',
                        text: `Ledger Snapshot for ${myName}`
                    });
                    if (statusText) statusText.innerText = 'Shared successfully!';
                    return;
                } catch (err) {
                    if (err.name === 'AbortError') {
                        if (statusText) statusText.innerText = '';
                        return;
                    }
                }
            }

            if (statusText) statusText.innerText = 'Press & hold the image to save directly.';
        };
    }

    if (modal) modal.style.display = 'flex';

    // Direct auto-click download attempt
    try {
        const autoLink = document.createElement('a');
        autoLink.href = activeScreenshotBlobUrl;
        autoLink.download = fileName;
        document.body.appendChild(autoLink);
        autoLink.click();
        document.body.removeChild(autoLink);
    } catch (e) {}
};

// -------------------------------------------------------------
// 4. LIFETIME LEDGER COORDINATOR
// -------------------------------------------------------------
window.openLifetimeLedgerModal = window.openLifetimeLedgerModal || function() {
    if (!window.userSession || window.userSession.isGuest) {
        alert("Guest accounts do not retain lifetime records. Create or log in with an account to track all-time balances.");
        return;
    }
    const sendFunc = window.initSocketAndSend || window.sendSocketMessage;
    if (typeof sendFunc === 'function') {
        sendFunc({ type: 'GET_LIFETIME_LEDGER' });
    }
};

window.renderLifetimeLedger = window.renderLifetimeLedger || function(balances) {
    const container = document.getElementById('lifetime-ledger-content');
    if (!container) return;

    if (!balances || balances.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); padding:6px;">No lifetime debts or credits recorded yet.</div>';
        if (typeof window.toggleModal === 'function') window.toggleModal('lifetime-ledger-modal');
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
    if (typeof window.toggleModal === 'function') window.toggleModal('lifetime-ledger-modal');
};

window.applyCreditToUser = window.applyCreditToUser || function(debtorId) {
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
