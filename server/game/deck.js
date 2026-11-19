// server/game/deck.js
const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Shuffles use the operating system's cryptographic random source, not Math.random(): Math.random's
// sequence can in theory be worked out from values the game shows (table codes, ids), which would let
// someone predict the deck. crypto.randomInt cannot be predicted and has no modulo bias.
const crypto = require('crypto');
function secureShuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
function secureIndex(n) { return n > 0 ? crypto.randomInt(n) : 0; }

function createDeck() {
    const deck = [];
    for (const s of SUITS) {
        for (const v of VALUES) {
            let points = 10;
            const drawVal = parseInt(v, 10) || (v === 'A' ? 14 : (v === 'K' ? 13 : (v === 'Q' ? 12 : 11)));
            if (v === 'A') points = 11;
            else if (['J', 'Q', 'K'].includes(v)) points = 10;
            else points = parseInt(v, 10);
            deck.push({ suit: s, val: v, points, drawVal });
        }
    }
    return secureShuffle(deck);
}

function calculateScore(cards) {
    const scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    const sums = {};
    scoringCards.forEach(c => { sums[c.suit] = (sums[c.suit] || 0) + c.points; });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(sums), 0);
}

function calculateBestFourCardScore(cards) {
    if (!cards || cards.length < 3) return 0;
    if (cards.length === 4) {
        return Math.max(
            calculateScore([cards[0], cards[1], cards[2]]),
            calculateScore([cards[0], cards[1], cards[3]]),
            calculateScore([cards[0], cards[2], cards[3]]),
            calculateScore([cards[1], cards[2], cards[3]])
        );
    }
    return calculateScore(cards);
}

module.exports = {
    SUITS,
    VALUES,
    createDeck,
    calculateScore,
    calculateBestFourCardScore, secureShuffle, secureIndex };
