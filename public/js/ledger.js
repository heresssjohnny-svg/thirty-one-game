// server/game/ledger.js - Side Bets & P2P Ledger Settlement
const path = require('path');

// Resilient SQLite Database Resolver
let db = null;
for (const p of ['../db', '../../db', '../services/db', '../../server/db']) {
    try { db = require(p); break; } catch (e) {}
}

/**
 * Persists human-vs-human debt to the SQLite Lifetime Ledger
 */
function persistToLifetimeLedger(debtorUsername, creditorUsername, amount) {
    if (!db || !debtorUsername || !creditorUsername || !amount) return;
    try {
        let debtorId = null;
        let creditorId = null;

        if (typeof db.getUserByUsername === 'function') {
            const debtorUser = db.getUserByUsername(debtorUsername);
            const creditorUser = db.getUserByUsername(creditorUsername);
            if (debtorUser) debtorId = debtorUser.id || debtorUser.userId;
            if (creditorUser) creditorId = creditorUser.id || creditorUser.userId;
        }

        if (debtorId && creditorId && typeof db.recordDebt === 'function') {
            db.recordDebt(debtorId, creditorId, Number(amount));
            console.log(`[LIFETIME LEDGER] Persisted P2P bet: ${debtorUsername} owes ${creditorUsername} $${amount}`);
        }
    } catch (err) {
        console.error('[LIFETIME LEDGER] Error persisting side bet to SQLite:', err);
    }
}

/**
 * Records a debt into an in-memory session ledger object
 */
function recordDebt(ledger, debtor, creditor, amount) {
    if (!ledger || !debtor || !creditor || !amount) return;
    if (!ledger[debtor]) ledger[debtor] = {};
    ledger[debtor][creditor] = (ledger[debtor][creditor] || 0) + Number(amount);
}

/**
 * Resolves "First to Lose / Elimination" side bets when a player drops to 0 lives
 */
function resolveFirstToLoseBets(lobby, loserUsername) {
    if (!lobby || !lobby.activeBets || !Array.isArray(lobby.activeBets)) return;
    if (!lobby.sideBetLedger) lobby.sideBetLedger = {};

    const unresolvedBets = [];

    lobby.activeBets.forEach(bet => {
        if (bet.type === 'eliminate') {
            const wager = Number(bet.wagerAmt) || 5;
            let debtor = null;
            let creditor = null;

            // If the bet specifically picked this loser to be eliminated first
            if (bet.pickUser && bet.pickUser.toLowerCase() === loserUsername.toLowerCase()) {
                debtor = bet.target;
                creditor = bet.proposer;
            } else if (bet.target && bet.target.toLowerCase() === loserUsername.toLowerCase()) {
                debtor = bet.target;
                creditor = bet.proposer;
            } else if (bet.proposer && bet.proposer.toLowerCase() === loserUsername.toLowerCase()) {
                debtor = bet.proposer;
                creditor = bet.target;
            } else {
                debtor = bet.proposer;
                creditor = bet.target;
            }

            if (debtor && creditor && debtor !== creditor) {
                // 1. Record in session ledger
                recordDebt(lobby.sideBetLedger, debtor, creditor, wager);

                // 2. Persist to SQLite Lifetime Ledger
                persistToLifetimeLedger(debtor, creditor, wager);
            }
        } else {
            unresolvedBets.push(bet);
        }
    });

    lobby.activeBets = unresolvedBets;
}

/**
 * Resolves "Match / Round Win" side bets when a player wins
 */
function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby || !lobby.activeBets || !Array.isArray(lobby.activeBets)) return;
    if (!lobby.sideBetLedger) lobby.sideBetLedger = {};

    const unresolvedBets = [];

    lobby.activeBets.forEach(bet => {
        if (bet.type === 'win') {
            const wager = Number(bet.wagerAmt) || 5;
            let debtor = null;
            let creditor = null;

            // If proposer picked winnerUsername to win
            if (bet.pickUser && bet.pickUser.toLowerCase() === winnerUsername.toLowerCase()) {
                debtor = bet.target;
                creditor = bet.proposer;
            } else {
                debtor = bet.proposer;
                creditor = bet.target;
            }

            if (debtor && creditor && debtor !== creditor) {
                // 1. Record in session ledger
                recordDebt(lobby.sideBetLedger, debtor, creditor, wager);

                // 2. Persist to SQLite Lifetime Ledger
                persistToLifetimeLedger(debtor, creditor, wager);
            }
        } else {
            unresolvedBets.push(bet);
        }
    });

    lobby.activeBets = unresolvedBets;
}

module.exports = {
    recordDebt,
    persistToLifetimeLedger,
    resolveFirstToLoseBets,
    resolveWinSideBets
};

// In server/game/ledger.js inside persistToLifetimeLedger
if (debtorId && creditorId && typeof db.recordDebt === 'function') {
    db.recordDebt(debtorId, creditorId, Number(amount));
    console.log(`[LIFETIME LEDGER] Persisted P2P bet: ${debtorUsername} owes ${creditorUsername} $${amount}`);

    // Push real-time balance refresh to all connected clients involved
    if (global.wss) {
        global.wss.clients.forEach(client => {
            if (client.readyState === 1 && client.user) {
                const cId = client.user.userId || client.user.id;
                if (cId === debtorId || cId === creditorId) {
                    const freshBalances = db.getLifetimeBalances(cId);
                    client.send(JSON.stringify({
                        type: 'LIFETIME_LEDGER_DATA',
                        balances: freshBalances || [],
                        isGuest: false
                    }));
                }
            }
        });
    }
}
