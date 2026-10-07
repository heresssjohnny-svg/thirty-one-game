// server/game/lobbyManager.js
const { createDeck, calculateScore, calculateBestFourCardScore } = require('./deck');
const { recordDebt, resolveFirstToLoseBets, resolveWinSideBets, awardTournamentWinner } = require('./ledger');
const { executeBotTurn } = require('./bot');

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

    // Rule: Must knock BEFORE drawing (cannot knock after drawing 4th card)
    if (p.cards.length !== 3) {
        return;
    }

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

    if (typeof broadcastCallback === 'function') {
        broadcastCallback(lobby.code);
    }

    let nextPlayer = lobby.players[lobby.turnIndex];
    if (nextPlayer && nextPlayer.isBot && !nextPlayer.eliminated) {
        setTimeout(() => {
            executeBotTurn(lobby, broadcastCallback);
        }, 1200);
    }
}

function advanceTurnOrResolve(lobby, broadcastCallback) {
    let active = getActiveParticipants(lobby);

    if (lobby.gameState === 'finalTurn') {
        lobby.finalTurnsRemaining--;
        if (lobby.finalTurnsRemaining <= 0) {
            resolveRoundEnd(lobby, broadcastCallback);
            return;
        }
    }

    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) {
        next = (next + 1) % lobby.players.length;
    }
    lobby.turnIndex = next;
    lobby.turnsTakenThisRound++;

    if (typeof broadcastCallback === 'function') {
        broadcastCallback(lobby.code);
    }

    let currentPlayer = lobby.players[lobby.turnIndex];
    if (currentPlayer && currentPlayer.isBot && !currentPlayer.eliminated) {
        setTimeout(() => {
            executeBotTurn(lobby, broadcastCallback);
        }, 1200);
    }
}

function resolveRoundEnd(lobby, broadcastCallback) {
    lobby.gameState = 'roundOver';
    let active = getActiveParticipants(lobby);
    let scores = active.map(p => ({ p, score: calculateScore(p.cards) }));
    let minScore = Math.min(...scores.map(s => s.score));
    let lowest = scores.filter(s => s.score === minScore);

    // Blitz check: 31 points
    let blitzWinner = scores.find(s => s.score === 31);
    if (blitzWinner) {
        lobby.phaseMessage = `⚡ BLITZ 31! ${blitzWinner.p.username} reached 31! All other players lose a life.`;
        scores.forEach(s => {
            if (s.p !== blitzWinner.p) {
                s.p.lives--;
                if (s.p.lives <= 0) s.p.eliminated = true;
            }
        });
        checkEliminationsAndProceed(lobby, broadcastCallback);
        return;
    }

    // Tie-breaker check for lowest score in multi-player games
    if (lowest.length > 1 && active.length > 2) {
        lobby.gameState = 'tieBreaker';
        lobby.tiedParticipantsList = lowest.map(l => l.p.username);
        lobby.tieBreakerDeck = createDeck();
        lobby.tieBreakerCardsDrawn = {};
        lobby.phaseMessage = `TIE FOR LOWEST SCORE (${minScore})! Tied players must draw a tie-breaker card.`;
        if (typeof broadcastCallback === 'function') {
            broadcastCallback(lobby.code);
        }
        return;
    }

    lowest.forEach(l => {
        l.p.lives--;
        if (l.p.lives <= 0) l.p.eliminated = true;
    });

    let losersNames = lowest.map(l => l.p.username).join(', ');
    lobby.phaseMessage = `Round Over! ${losersNames} had the lowest score (${minScore}) and lost a life.`;
    checkEliminationsAndProceed(lobby, broadcastCallback);
}

function checkEliminationsAndProceed(lobby, broadcastCallback) {
    resolveFirstToLoseBets(lobby);
    let active = getActiveParticipants(lobby);

    if (active.length <= 1) {
        let winner = active[0] || null;
        if (winner) {
            awardTournamentWinner(lobby, winner.username);
            lobby.phaseMessage = `🏆 TOURNAMENT OVER! ${winner.username} WINS THE TOURNAMENT!`;
        } else {
            lobby.phaseMessage = `Game ended in a draw!`;
        }
        lobby.gameState = 'lobby';
        lobby.players.forEach(p => {
            p.lives = lobby.startingLives || 3;
            p.eliminated = false;
            p.ready = false;
            p.cards = [];
        });
    }

    advanceDealerToNextActive(lobby);
    if (typeof broadcastCallback === 'function') {
        broadcastCallback(lobby.code);
    }
}

module.exports = {
    getActiveParticipants,
    advanceDealerToNextActive,
    handleKnock,
    advanceTurnOrResolve,
    resolveRoundEnd,
    checkEliminationsAndProceed
};
