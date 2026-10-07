// server/game/ledger.js

function recordDebt(ledger, debtor, creditor, amount) {
    if (!ledger[debtor]) ledger[debtor] = {};
    ledger[debtor][creditor] = (ledger[debtor][creditor] || 0) + amount;
}

function resolveFirstToLoseBets(lobby, loserUsername) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    lobby.activeBets = lobby.activeBets.filter(b => {
        if (b.type === 'eliminate' && b.pickUser === loserUsername) {
            const isBotInvolved = b.isBotBet || lobby.players.some(p => p.isBot && (p.username === b.target || p.username === b.proposer));
            const targetLedger = isBotInvolved ? (lobby.botBetLedger = lobby.botBetLedger || {}) : (lobby.sideBetLedger = lobby.sideBetLedger || {});
            recordDebt(targetLedger, b.target, b.proposer, b.wagerAmt);
            lobby.phaseMessage = `💰 ${isBotInvolved ? 'Bot Bet' : 'Side Bet'} Won! ${b.proposer} won $${b.wagerAmt} from ${b.target}!`;
            return false;
        }
        return true;
    });
}

function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby.activeBets || lobby.activeBets.length === 0) return;
    lobby.activeBets = lobby.activeBets.filter(b => {
        if (b.type === 'win') {
            const isBotInvolved = b.isBotBet || lobby.players.some(p => p.isBot && (p.username === b.target || p.username === b.proposer));
            const targetLedger = isBotInvolved ? (lobby.botBetLedger = lobby.botBetLedger || {}) : (lobby.sideBetLedger = lobby.sideBetLedger || {});
            if (b.pickUser === winnerUsername) {
                recordDebt(targetLedger, b.target, b.proposer, b.wagerAmt);
                lobby.phaseMessage = `💰 ${isBotInvolved ? 'Bot Bet' : 'Side Bet'} Won! ${b.proposer} won $${b.wagerAmt} from ${b.target}!`;
            } else {
                recordDebt(targetLedger, b.proposer, b.target, b.wagerAmt);
                lobby.phaseMessage = `💰 ${isBotInvolved ? 'Bot Bet' : 'Side Bet'} Won! ${b.target} won $${b.wagerAmt} from ${b.proposer}!`;
            }
            return false;
        }
        return true;
    });
}

module.exports = {
    recordDebt,
    resolveFirstToLoseBets,
    resolveWinSideBets
};
