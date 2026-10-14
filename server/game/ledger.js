// server/game/ledger.js - Session Debt Recording & Side Bet Resolution Engine

/**
 * Records a debt from debtor to creditor in the given ledger object.
 */
function recordDebt(ledger, debtor, creditor, amount) {
    if (!ledger || !debtor || !creditor || debtor.toLowerCase() === creditor.toLowerCase()) return;
    const amt = Number(amount) || 0;
    if (amt <= 0) return;

    if (!ledger[debtor]) ledger[debtor] = {};
    ledger[debtor][creditor] = (Number(ledger[debtor][creditor]) || 0) + amt;
}

/**
 * Clears bilateral debts between two players in the given ledger.
 */
function clearDebts(ledger, userA, userB) {
    if (!ledger || !userA || !userB) return;
    if (ledger[userA]) delete ledger[userA][userB];
    if (ledger[userB]) delete ledger[userB][userA];
}

/**
 * Resolves "First to Lose" (Elimination) side bets when a player loses all their lives.
 * Rule: Determines if the proposer loses all their lives before the target,
 * and pays whichever of the two is still alive when the other loses all their lives.
 */
function resolveFirstToLoseBets(lobby, eliminatedUsername) {
    if (!lobby || !Array.isArray(lobby.activeBets) || !eliminatedUsername) return;
    if (!lobby.sideBetLedger) lobby.sideBetLedger = {};
    if (!lobby.botBetLedger) lobby.botBetLedger = {};

    const elimLower = String(eliminatedUsername).trim().toLowerCase();
    const remainingBets = [];

    for (const bet of lobby.activeBets) {
        const isElimBet = (bet.type === 'eliminate' || bet.type === 'first_out');
        if (!isElimBet) {
            remainingBets.push(bet);
            continue;
        }

        const proposerName = (bet.proposer || bet.bettor || bet.targetSurvivor || '').trim();
        const targetName = (bet.target || bet.pickUser || '').trim();
        const proposerLower = proposerName.toLowerCase();
        const targetLower = targetName.toLowerCase();

        // If the eliminated player is neither the proposer nor the target, keep the bet active
        if (elimLower !== proposerLower && elimLower !== targetLower) {
            remainingBets.push(bet);
            continue;
        }

        const proposerPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === proposerLower);
        const targetPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === targetLower);

        const isProposerAlive = Boolean(proposerPlayer && !proposerPlayer.eliminated && proposerPlayer.lives > 0);
        const isTargetAlive = Boolean(targetPlayer && !targetPlayer.eliminated && targetPlayer.lives > 0);

        const wagerAmt = Number(bet.wagerAmt) || 5;
        const isBotInvolved = Boolean(
            bet.isBotBet ||
            (proposerPlayer && proposerPlayer.isBot) ||
            (targetPlayer && targetPlayer.isBot)
        );
        const targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.sideBetLedger;

        if (elimLower === proposerLower && isTargetAlive) {
            // Proposer lost all their lives before Target -> Proposer owes Target
            recordDebt(targetLedger, proposerPlayer ? proposerPlayer.username : proposerName, targetPlayer.username, wagerAmt);
        } else if (elimLower === targetLower && isProposerAlive) {
            // Target lost all their lives before Proposer -> Target owes Proposer
            recordDebt(targetLedger, targetPlayer ? targetPlayer.username : targetName, proposerPlayer.username, wagerAmt);
        }
        // If neither is alive (both lost their last life on the same 31 hand), it's a push: no payout, bet is removed.
    }

    lobby.activeBets = remainingBets;
}

/**
 * Resolves Single-Round Global "Win" side bets ("I like [pickUser] to win").
 * Valid ONLY for the round in which it was placed.
 * - If winnerUsername is provided: pays Proposer if pickUser won the round, otherwise pays Accepter.
 * - If winnerUsername is null (round tied for highest score): pushes and clears all single-round 'win' bets.
 */
function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby) return;
    if (!lobby.sideBetLedger) lobby.sideBetLedger = {};
    if (!lobby.botBetLedger) lobby.botBetLedger = {};

    // Always wipe any unconfirmed/unaccepted global proposals when the round ends
    lobby.globalProposals = [];

    if (!Array.isArray(lobby.activeBets) || lobby.activeBets.length === 0) return;

    const winnerLower = winnerUsername ? String(winnerUsername).trim().toLowerCase() : null;
    const remainingBets = [];

    for (const bet of lobby.activeBets) {
        // Keep First-to-Lose bets active across rounds until elimination
        if (bet.type === 'eliminate' || bet.type === 'first_out') {
            remainingBets.push(bet);
            continue;
        }

        // If the round ended in a tie (no single round winner), the single-round global bet is a push (cleared without charge)
        if (!winnerLower) {
            continue;
        }

        const proposerName = (bet.proposer || bet.bettor || '').trim();
        const accepterName = (bet.target || '').trim();
        const pickName = (bet.pickUser || proposerName).trim();

        if (!proposerName || !accepterName) continue;

        const wagerAmt = Number(bet.wagerAmt) || 5;
        const proposerPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === proposerName.toLowerCase());
        const accepterPlayer = (lobby.players || []).find(p => p.username.toLowerCase() === accepterName.toLowerCase());
        const isBotInvolved = Boolean(
            bet.isBotBet ||
            (proposerPlayer && proposerPlayer.isBot) ||
            (accepterPlayer && accepterPlayer.isBot)
        );
        const targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.sideBetLedger;

        if (pickName.toLowerCase() === winnerLower) {
            // Proposer's pick won this round -> Accepter owes Proposer
            recordDebt(targetLedger, accepterName, proposerName, wagerAmt);
        } else {
            // Proposer's pick did not win this round -> Proposer owes Accepter
            recordDebt(targetLedger, proposerName, accepterName, wagerAmt);
        }
    }

    lobby.activeBets = remainingBets;
}

module.exports = {
    recordDebt,
    clearDebts,
    resolveFirstToLoseBets,
    resolveWinSideBets
};
