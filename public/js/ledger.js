// server/game/ledger.js

/**
 * Records a debt with immediate peer-to-peer bilateral netting.
 * If creditor already owes debtor $4 and debtor now owes creditor $10,
 * the $4 debt is wiped and debtor owes creditor net $6.
 */
function recordDebt(ledger, debtor, creditor, amount) {
    amount = Number(amount) || 0;
    if (!debtor || !creditor || debtor === creditor || amount <= 0) return;

    if (!ledger[debtor]) ledger[debtor] = {};
    if (!ledger[creditor]) ledger[creditor] = {};

    const reverseDebt = Number(ledger[creditor][debtor]) || 0;

    if (reverseDebt > 0) {
        if (amount >= reverseDebt) {
            delete ledger[creditor][debtor];
            const net = amount - reverseDebt;
            if (net > 0) {
                ledger[debtor][creditor] = (Number(ledger[debtor][creditor]) || 0) + net;
            }
        } else {
            ledger[creditor][debtor] = reverseDebt - amount;
        }
    } else {
        ledger[debtor][creditor] = (Number(ledger[debtor][creditor]) || 0) + amount;
    }

    if (ledger[creditor] && Object.keys(ledger[creditor]).length === 0) {
        delete ledger[creditor];
    }
    if (ledger[debtor] && Object.keys(ledger[debtor]).length === 0) {
        delete ledger[debtor];
    }
}

function clearDebts(ledger, debtor, creditor) {
    if (!ledger) return;
    if (debtor && creditor) {
        if (ledger[debtor]) delete ledger[debtor][creditor];
        if (ledger[creditor]) delete ledger[creditor][debtor];
    }
}

/**
 * Resolves win side bets, records exact 1x wager (not double),
 * and removes settled bets from lobby.activeBets.
 */
function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby || !lobby.activeBets || lobby.activeBets.length === 0) return;
    const targetLedger = lobby.sideBetLedger || (lobby.sideBetLedger = {});
    const botLedger = lobby.botBetLedger || (lobby.botBetLedger = {});

    const remainingBets = [];

    lobby.activeBets.forEach(bet => {
        if (bet.type === 'eliminate' || bet.type === 'first_out') {
            remainingBets.push(bet);
            return;
        }

        const bettor = bet.proposer || bet.bettor;
        const target = bet.target;
        const pick = bet.pickUser || bettor;
        const wager = Number(bet.wagerAmt) || 5;

        const isBot = lobby.players?.some(p => (p.username === bettor || p.username === target) && p.isBot);
        const ledger = isBot ? botLedger : targetLedger;

        if (pick.toLowerCase() === winnerUsername.toLowerCase()) {
            recordDebt(ledger, target, bettor, wager);
        } else {
            recordDebt(ledger, bettor, target, wager);
        }
    });

    lobby.activeBets = remainingBets;
}

/**
 * Resolves first-to-lose elimination bets and removes settled bets.
 */
function resolveFirstToLoseBets(lobby, eliminatedUsername) {
    if (!lobby || !lobby.activeBets || lobby.activeBets.length === 0) return;
    const targetLedger = lobby.sideBetLedger || (lobby.sideBetLedger = {});
    const botLedger = lobby.botBetLedger || (lobby.botBetLedger = {});

    const remainingBets = [];

    lobby.activeBets.forEach(bet => {
        if (bet.type !== 'eliminate' && bet.type !== 'first_out') {
            remainingBets.push(bet);
            return;
        }

        const bettor = bet.proposer || bet.bettor;
        const target = bet.target;
        const pick = bet.pickUser;
        const wager = Number(bet.wagerAmt) || 5;

        const isBot = lobby.players?.some(p => (p.username === bettor || p.username === target) && p.isBot);
        const ledger = isBot ? botLedger : targetLedger;

        if (pick && pick.toLowerCase() === eliminatedUsername.toLowerCase()) {
            recordDebt(ledger, target, bettor, wager);
        } else if (bettor.toLowerCase() === eliminatedUsername.toLowerCase()) {
            recordDebt(ledger, bettor, target, wager);
        } else {
            remainingBets.push(bet);
        }
    });

    lobby.activeBets = remainingBets;
}

module.exports = {
    recordDebt,
    clearDebts,
    resolveWinSideBets,
    resolveFirstToLoseBets
};
