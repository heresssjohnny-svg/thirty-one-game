// server/game/bot.js
const { calculateScore, calculateBestFourCardScore } = require('./deck');

const BOT_NAMES = ['Liam', 'Emma', 'Noah', 'Olivia', 'Ethan', 'Sophia', 'Marcus', 'Ava', 'Lucas', 'Chloe', 'Jackson', 'Mia', 'Leo', 'Harper', 'Aiden', 'Ella'];

function syncBotReadiness(lobby) {
    if (!lobby || lobby.gameState !== 'lobby') return false;
    const humans = lobby.players.filter(p => !p.isBot && !p.eliminated);
    const allHumansReady = humans.length > 0 && humans.every(p => p.ready);

    let changed = false;
    lobby.players.forEach(p => {
        if (p.isBot) {
            if (p.ready !== allHumansReady) {
                p.ready = allHumansReady;
                changed = true;
            }
        }
    });
    return changed;
}

function getPrimarySuit(cards) {
    const suitCounts = {};
    cards.forEach(c => suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1);
    let best = cards[0]?.suit || '♠';
    let max = 0;
    for (let s in suitCounts) {
        if (suitCounts[s] > max) {
            max = suitCounts[s];
            best = s;
        }
    }
    return best;
}

function executeBotTurn(lobby, bot, handlers) {
    if (!lobby || !bot || bot.eliminated || !handlers) return;
    const active = lobby.players.filter(p => !p.eliminated);
    const curScore = calculateScore(bot.cards);
    const minKnockReq = active.length > 2 ? 21 : 25;
    const canKnock = lobby.gameState === 'playing' && !lobby.knockedBy && (lobby.turnsTakenThisRound >= active.length) && (curScore >= minKnockReq);

    // Rule: Bots can only knock BEFORE drawing (holding exactly 3 cards)
    if (canKnock && bot.cards.length === 3) {
        const knockThreshold = curScore >= 28 ? 0.95 : (curScore >= 26 ? 0.75 : 0.30);
        if (Math.random() < knockThreshold) {
            handlers.handleKnock(lobby, bot.id);
            return;
        }
    }

    // Bot Draw Evaluation (7.5/10 intelligence)
    const topDiscard = lobby.discardPile[lobby.discardPile.length - 1];
    let shouldDrawDiscard = false;

    if (topDiscard) {
        const scoreWithDiscard = calculateBestFourCardScore([...bot.cards, topDiscard]);
        if (scoreWithDiscard > curScore) {
            shouldDrawDiscard = true;
        } else if (scoreWithDiscard === curScore && topDiscard.points >= 10) {
            const primarySuit = getPrimarySuit(bot.cards);
            if (topDiscard.suit === primarySuit) {
                shouldDrawDiscard = Math.random() < 0.65;
            }
        }
    }

    handlers.handleTurnAction(lobby, bot.id, shouldDrawDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK');

    if (lobby.gameState === 'roundOver') return;

    // Bot Discard Evaluation
    setTimeout(() => {
        if (!lobby || (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn')) return;
        const activeBot = lobby.players[lobby.turnIndex];
        if (!activeBot || activeBot.id !== bot.id || activeBot.cards.length !== 4) return;

        let bestDiscardIdx = -1;
        let maxRetainedScore = -1;
        let lowestPointVal = 999;

        for (let i = 0; i < 4; i++) {
            const testHand = activeBot.cards.filter((_, idx) => idx !== i);
            const score = calculateScore(testHand);
            const cardPoint = activeBot.cards[i].points;

            if (score > maxRetainedScore || (score === maxRetainedScore && cardPoint < lowestPointVal)) {
                maxRetainedScore = score;
                lowestPointVal = cardPoint;
                bestDiscardIdx = i;
            }
        }

        handlers.handleDiscardAction(lobby, activeBot.id, bestDiscardIdx !== -1 ? bestDiscardIdx : 0);
    }, 700 + Math.random() * 500);
}

module.exports = {
    BOT_NAMES,
    syncBotReadiness,
    executeBotTurn
};
