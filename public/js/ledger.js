/**
 * Calculates bilateral/pairwise net balances from raw ledger debts.
 * Relies on the global math engine loaded from ui.js
 */
function calculatePairwiseNet(ledger) {
    if (!ledger) return [];
    if (typeof window.calculatePairwiseNet === 'function') {
        return window.calculatePairwiseNet(ledger);
    }
    return [];
}

function renderSessionLedger() {
    const container = document.getElementById('session-ledger-content') 
        || document.getElementById('ledger-content')
        || document.getElementById('session-ledger-list');
    if (!container) return;

    const lobby = window.appGlobals?.latestLobbySnapshot || {};
    const mainLedger = lobby.mainGameLedger || window.clientState?.mainGameLedger || {};
    const sideLedger = lobby.sideBetLedger || window.clientState?.sideBetLedger || {};

    const mainNet = calculatePairwiseNet(mainLedger);
    const sideNet = calculatePairwiseNet(sideLedger);
    
    // Combine the pre-netted arrays directly
    const rows = [...mainNet, ...sideNet];

    if (rows.length === 0) {
        container.innerHTML = `
            <div class="ledger-empty-msg" style="text-align: center; color: #a7f3d0; padding: 1.5rem 0; font-size: 0.95rem;">
                No active session debts. All square!
            </div>
        `;
        return;
    }

    const myUsername = (window.clientState?.username || '').toLowerCase();
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
