// server/game/lobbyManager.js
const { createDeck, calculateScore, calculateBestFourCardScore } = require('./deck');
const { recordDebt, resolveFirstToLoseBets, resolveWinSideBets, awardTournamentWinner } = require('./ledger');

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function advanceDealerToNextActive(lobby) {
    let nextDealer = (lobby.dealerIndex + 1) % lobby.players.length;
    let safetyCounter = 0;
    while (lobby.players[nextDealer].eliminated && safetyCounter < lobby.players.length) {
        nextDealer = (nextDealer + 1) % lobby.players.length;
        safetyCounter++;
    }
    lobby.dealerIndex = nextDealer;
}

function handleKnock(lobby, ws, broadcastCallback) {
    if (lobby.gameState !== 'playing') return;
    let p = lobby.players[lobby.turnIndex];
    if (!p || p.id !== ws || lobby.knockedBy) return;

    // RULE: Must knock BEFORE drawing (cannot knock after drawing from deck or discard)
    if (p.cards.length !== 3) return;

    let active = getActiveParticipants(lobby);
    if (lobby.turnsTakenThisRound < active.length) return;
    if (calculateScore(p.cards) < (active.length > 2 ? 21 : 25)) return;

    lobby.gameState = 'finalTurn';
    lobby.knockedBy = p.username;
    lobby.finalTurnsRemaining = active.length - 1;
    lobby.phaseMessage = `🔔 KNOCK! ${p.username} knocked! 1 final turn each.`;

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) next = (next + 1) % lobby.players.length;
    lobby.turnIndex = next;

    broadcastCallback(lobby.code);
}

module.exports = {
    getActiveParticipants,
    advanceDealerToNextActive,
    handleKnock
};
