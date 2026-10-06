const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const BOT_NAMES = ['Liam', 'Emma', 'Noah', 'Olivia', 'Ethan', 'Sophia', 'Marcus', 'Ava', 'Lucas', 'Chloe', 'Jackson', 'Mia', 'Leo', 'Harper', 'Aiden', 'Ella'];

let lobbies = {};

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let val of VALUES) {
            let pts = 0;
            let drawVal = 0;
            if (['J', 'Q', 'K'].includes(val)) pts = 10;
            else if (val === 'A') pts = 11;
            else pts = parseInt(val);

            if (val === 'A') drawVal = 14;
            else if (val === 'K') drawVal = 13;
            else if (val === 'Q') drawVal = 12;
            else if (val === 'J') drawVal = 11;
            else drawVal = parseInt(val);

            deck.push({ suit, val, points: pts, drawVal });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function calculateScore(cards) {
    let scoringCards = cards.length === 4 ? cards.slice(0, 3) : cards;
    if (!scoringCards || scoringCards.length === 0) return 0;
    let suitSums = {};
    scoringCards.forEach(c => {
        suitSums[c.suit] = (suitSums[c.suit] || 0) + c.points;
    });
    if (scoringCards.length === 3 && scoringCards[0].val === scoringCards[1].val && scoringCards[0].val === scoringCards[2].val) {
        return 30.5;
    }
    return Math.max(...Object.values(suitSums), 0);
}

function calculateBestFourCardScore(cards) {
    if (!cards || cards.length < 3) return 0;
    if (cards.length === 4) {
        let scores = [
            calculateScore([cards[0], cards[1], cards[2]]),
            calculateScore([cards[0], cards[1], cards[3]]),
            calculateScore([cards[0], cards[2], cards[3]]),
            calculateScore([cards[1], cards[2], cards[3]])
        ];
        return Math.max(...scores);
    }
    return calculateScore(cards);
}

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function isPlayerBot(lobby, username) {
    let p = lobby.players.find(pl => pl.username === username);
    return !!(p && p.isBot);
}

function getAvailableSeat(lobby) {
    let occupied = lobby.players.map(p => p.seat);
    for (let i = 0; i < 6; i++) {
        if (!occupied.includes(i)) return i;
    }
    return lobby.players.length;
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

function startDealerDrawPhase(lobby) {
    let deck = createDeck();
    lobby.drawPool = deck.map(c => ({ card: c, chosenBy: null }));
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.players.forEach(p => {
        if (!p.eliminated) p.nextHandReady = p.isBot;
    });
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function startRound(lobby) {
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.knockedBy = null;
    lobby.gameState = 'playing';
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;

    let activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1) {
        awardTournamentWinner(lobby, activeParts[0]);
        return;
    }

    activeParts.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.nextHandReady = p.isBot;
    });

    let firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.initialDealCard = { val: firstDiscard.val, suit: firstDiscard.suit };
    lobby.lastDiscardDonor = lobby.players[lobby.dealerIndex]?.username || null;

    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    }

    lobby.phaseMessage = `Round started! Turn: ${lobby.players[lobby.turnIndex].username}`;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handlePoolCardSelection(lobby, username, cardIndex) {
    if (lobby.gameState === 'tieBreaker' && !lobby.tiedParticipantsList.includes(username)) return;
    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        let card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        if (!lobby.drawOrderSequence) lobby.drawOrderSequence = [];
        lobby.drawOrderSequence.push({ username, card });
        broadcastLobbyUpdate(lobby.code);

        let activeParts = getActiveParticipants(lobby);
        if (lobby.gameState === 'dealerDraw' && activeParts.every(p => lobby.drawResults[p.username])) {
            let entries = Object.entries(lobby.drawResults).map(([u, c]) => ({ username: u, card: c })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            lobby.dealerIndex = lobby.players.findIndex(p => p.username === entries[0].username);
            lobby.phaseMessage = `🎉 ${entries[0].username} drew lowest and is Dealer!`;
            broadcastLobbyUpdate(lobby.code);
            setTimeout(() => {
                if (lobbies[lobby.code]) startRound(lobbies[lobby.code]);
            }, 3500);
        } else if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.every(u => lobby.drawResults[u])) {
            let entries = lobby.tiedParticipantsList.map(u => ({ username: u, card: lobby.drawResults[u] })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            let loser = lobby.players.find(p => p.username === entries[0].username);
            if (loser) {
                loser.lives = Math.max(0, loser.lives - 1);
                if (loser.lives <= 0 && !loser.eliminated) {
                    loser.eliminated = true;
                    resolveFirstToLoseBets(lobby, loser.username);
                    lobby.spectators.push({ idSocket: loser.id, username: loser.username });
                }
            }
            lobby.phaseMessage = `${entries[0].username} drew lowest in tie-breaker!`;
            broadcastLobbyUpdate(lobby.code);
            setTimeout(() => {
                if (!lobbies[lobby.code]) return;
                let currentLobby = lobbies[lobby.code];
                if (getActiveParticipants(currentLobby).length === 1) {
                    awardTournamentWinner(currentLobby, getActiveParticipants(currentLobby)[0]);
                } else {
                    advanceDealerToNextActive(currentLobby);
                    triggerRoundOver(currentLobby, `${entries[0].username} lost a life in tie-breaker!`);
                }
            }, 3000);
        } else {
            scheduleBotActions(lobby);
        }
    }
}

function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the draw pile.`;
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        let card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
        currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up ${card.val}${card.suit} from the discard pile!`;

        if (lobby.initialDealCard && card.val === lobby.initialDealCard.val && card.suit === lobby.initialDealCard.suit) {
            lobby.lastDiscardPickup = { username: currentPlayer.username, card: { val: card.val, suit: card.suit } };
        }

        if (lobby.lastDiscardDonor && lobby.lastDiscardDonor !== currentPlayer.username) {
            if (!lobby.fedCardReminders) lobby.fedCardReminders = {};
            lobby.fedCardReminders[lobby.lastDiscardDonor] = {
                target: currentPlayer.username,
                card: { val: card.val, suit: card.suit }
            };
        }
    }

    if (calculateBestFourCardScore(currentPlayer.cards) === 31) {
        lobby.players.forEach(p => {
            if (p !== currentPlayer && !p.eliminated) {
                p.lives = Math.max(0, p.lives - 1);
                if (p.lives <= 0) {
                    p.eliminated = true;
                    resolveFirstToLoseBets(lobby, p.username);
                    lobby.spectators.push({ idSocket: p.id, username: p.username });
                }
            }
        });
        resolveWinSideBets(lobby, currentPlayer.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points!`);
        return;
    }

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleDiscardAction(lobby, wsId, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    let currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.cards.length !== 4) return;

    let discarded = currentPlayer.cards[cardIndex];
    if (currentPlayer.pickedUpDiscardCard && discarded.val === currentPlayer.pickedUpDiscardCard.val && discarded.suit === currentPlayer.pickedUpDiscardCard.suit) {
        currentPlayer.cards.splice(cardIndex, 1);
        lobby.discardPile.push(discarded);
        currentPlayer.pickedUpDiscardCard = null;
        if (lobby.lastDiscardPickup?.username === currentPlayer.username && lobby.lastDiscardPickup.card.val === discarded.val && lobby.lastDiscardPickup.card.suit === discarded.suit) {
            lobby.lastDiscardPickup = null;
        }
        lobby.phaseMessage = `📢 ${currentPlayer.username} put the discard back. Must draw from deck!`;
        broadcastLobbyUpdate(lobby.code);
        scheduleBotActions(lobby);
        return;
    }

    currentPlayer.cards.splice(cardIndex, 1);
    currentPlayer.pickedUpDiscardCard = null;
    lobby.discardPile.push(discarded);

    if (lobby.fedCardReminders) {
        for (let donor in lobby.fedCardReminders) {
            if (lobby.fedCardReminders[donor].target === currentPlayer.username) {
                let remCard = lobby.fedCardReminders[donor].card;
                if (remCard.val === discarded.val && remCard.suit === discarded.suit) {
                    delete lobby.fedCardReminders[donor];
                }
            }
        }
    }

    lobby.lastDiscardDonor = currentPlayer.username;
    if (lobby.lastDiscardPickup?.username === currentPlayer.username && lobby.lastDiscardPickup.card.val === discarded.val && lobby.lastDiscardPickup.card.suit === discarded.suit) {
        lobby.lastDiscardPickup = null;
    }

    lobby.turnsTakenThisRound++;
    let score = calculateScore(currentPlayer.cards);
    if (score === 31) {
        lobby.players.forEach(p => {
            if (p !== currentPlayer && !p.eliminated) {
                p.lives = Math.max(0, p.lives - 1);
                if (p.lives <= 0) {
                    p.eliminated = true;
                    resolveFirstToLoseBets(lobby, p.username);
                    lobby.spectators.push({ idSocket: p.id, username: p.username });
                }
            }
        });
        resolveWinSideBets(lobby, currentPlayer.username);
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `Round Over! ${currentPlayer.username} hit 31 points!`);
    } else {
        advanceTurnOrResolve(lobby);
    }
}

function handleKnock(lobby, wsId) {
    if (lobby.gameState !== 'playing') return;
    let p = lobby.players[lobby.turnIndex];
    if (!p || p.id !== wsId || lobby.knockedBy) return;
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
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function advanceTurnOrResolve(lobby) {
    if (lobby.gameState === 'finalTurn') {
        lobby.finalTurnsRemaining--;
        if (lobby.finalTurnsRemaining <= 0) {
            resolveRoundEnd(lobby);
            return;
        }
    }
    let next = (lobby.turnIndex + 1) % lobby.players.length;
    while (lobby.players[next].eliminated) next = (next + 1) % lobby.players.length;
    lobby.turnIndex = next;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function resolveRoundEnd(lobby) {
    let active = getActiveParticipants(lobby);
    let scores = active.map(p => ({ player: p, score: calculateScore(p.cards) }));
    let minScore = Math.min(...scores.map(s => s.score));
    let losers = scores.filter(s => s.score === minScore);

    if (losers.length > 1) {
        lobby.tiedParticipantsList = losers.map(l => l.player.username);
        let deck = createDeck();
        lobby.drawPool = deck.map(c => ({ card: c, chosenBy: null }));
        lobby.drawResults = {};
        lobby.drawOrderSequence = [];
        lobby.gameState = 'tieBreaker';
        lobby.phaseMessage = `Tie for lowest score (${minScore} pts)! Draw to resolve.`;
        broadcastLobbyUpdate(lobby.code);
        scheduleBotActions(lobby);
        return;
    }

    let loser = losers[0].player;
    loser.lives = Math.max(0, loser.lives - 1);
    if (loser.lives <= 0) {
        loser.eliminated = true;
        resolveFirstToLoseBets(lobby, loser.username);
        lobby.spectators.push({ idSocket: loser.id, username: loser.username });
    }

    let remaining = getActiveParticipants(lobby);
    if (remaining.length === 1) {
        awardTournamentWinner(lobby, remaining[0]);
    } else {
        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, `Round Over! ${loser.username} had lowest score (${minScore} pts) and lost 1 life!`);
    }
}

function triggerRoundOver(lobby, msg) {
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;
    lobby.players.forEach(p => {
        p.nextHandReady = p.isBot;
    });
    broadcastLobbyUpdate(lobby.code);
}

function awardTournamentWinner(lobby, winner) {
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    if (!lobby.botBetLedger) lobby.botBetLedger = {};

    lobby.players.forEach(p => {
        if (p.username !== winner.username) {
            let wagerAmt = p.wager || 5;
            let isBotDebtorOrCreditor = p.isBot || winner.isBot;
            let targetLedger = isBotDebtorOrCreditor ? lobby.botBetLedger : lobby.mainGameLedger;
            if (!targetLedger[p.username]) targetLedger[p.username] = {};
            targetLedger[p.username][winner.username] = (targetLedger[p.username][winner.username] || 0) + wagerAmt;
        }
    });

    lobby.gameState = 'roundOver';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} wins the match!`;
    broadcastLobbyUpdate(lobby.code);
}

function resolveFirstToLoseBets(lobby, loserUsername) {
    if (!lobby.activeBets) return;
    lobby.activeBets = lobby.activeBets.filter(bet => {
        if (bet.type === 'eliminate' && bet.pickUser === loserUsername) {
            let debtor = bet.target;
            let creditor = bet.proposer;
            let isBotInvolved = bet.isBotBet || isPlayerBot(lobby, debtor) || isPlayerBot(lobby, creditor);
            let targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.sideBetLedger;
            if (!targetLedger[debtor]) targetLedger[debtor] = {};
            targetLedger[debtor][creditor] = (targetLedger[debtor][creditor] || 0) + bet.wagerAmt;
            lobby.phaseMessage = `💰 ${isBotInvolved ? 'Bot Bet' : 'Side Bet'} Won! ${creditor} won $${bet.wagerAmt} because ${loserUsername} lost first!`;
            return false;
        }
        return true;
    });
}

function resolveWinSideBets(lobby, winnerUsername) {
    if (!lobby.activeBets) return;
    lobby.activeBets = lobby.activeBets.filter(bet => {
        if (bet.type === 'win' && bet.pickUser === winnerUsername) {
            let debtor = bet.target;
            let creditor = bet.proposer;
            let isBotInvolved = bet.isBotBet || isPlayerBot(lobby, debtor) || isPlayerBot(lobby, creditor);
            let targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.sideBetLedger;
            if (!targetLedger[debtor]) targetLedger[debtor] = {};
            targetLedger[debtor][creditor] = (targetLedger[debtor][creditor] || 0) + bet.wagerAmt;
            lobby.phaseMessage = `💰 ${isBotInvolved ? 'Bot Bet' : 'Side Bet'} Won! ${creditor} won $${bet.wagerAmt} because ${winnerUsername} won!`;
            return false;
        }
        return true;
    });
}

function checkNextHandReady(lobby) {
    let activeParts = getActiveParticipants(lobby);
    let allReady = activeParts.every(p => p.nextHandReady);
    if (allReady && activeParts.length > 1) {
        startRound(lobby);
    } else if (activeParts.length <= 1) {
        resetLobbyToReadyRoom(lobby, "Match completed! Returned to ready room.");
    } else {
        broadcastLobbyUpdate(lobby.code);
    }
}

function resetLobbyToReadyRoom(lobby, msg) {
    lobby.gameState = 'lobby';
    lobby.phaseMessage = msg || "Returned to waiting room.";
    lobby.knockedBy = null;
    lobby.lastDiscardPickup = null;
    lobby.initialDealCard = null;
    lobby.players.forEach(p => {
        p.lives = lobby.defaultLives || 2;
        p.eliminated = false;
        p.cards = [];
        p.ready = p.isBot;
        p.nextHandReady = p.isBot;
    });
    lobby.spectators = [];
    broadcastLobbyUpdate(lobby.code);
}

// Bot AI Engine (Intelligence 7.5 / 10)
function scheduleBotActions(lobby) {
    if (!lobby) return;

    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
        lobby.players.forEach(p => {
            if (p.isBot && !p.eliminated) {
                let needsPick = false;
                if (lobby.gameState === 'dealerDraw' && !lobby.drawResults[p.username]) needsPick = true;
                if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.includes(p.username) && !lobby.drawResults[p.username]) needsPick = true;

                if (needsPick) {
                    setTimeout(() => {
                        let curLobby = lobbies[lobby.code];
                        if (!curLobby || (curLobby.gameState !== 'dealerDraw' && curLobby.gameState !== 'tieBreaker')) return;
                        let unchosen = curLobby.drawPool.map((c, i) => ({ i, chosen: c.chosenBy })).filter(c => c.chosen === null);
                        if (unchosen.length > 0) {
                            let chosenIndex = unchosen[Math.floor(Math.random() * unchosen.length)].i;
                            handlePoolCardSelection(curLobby, p.username, chosenIndex);
                        }
                    }, 600 + Math.random() * 800);
                }
            }
        });
        return;
    }

    if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
        let cur = lobby.players[lobby.turnIndex];
        if (!cur || !cur.isBot || cur.eliminated) return;

        setTimeout(() => {
            let curLobby = lobbies[lobby.code];
            if (!curLobby || (curLobby.gameState !== 'playing' && curLobby.gameState !== 'finalTurn')) return;
            let bot = curLobby.players[curLobby.turnIndex];
            if (!bot || bot.id !== cur.id) return;

            executeBotTurn(curLobby, bot);
        }, 850 + Math.random() * 650);
    }
}

function executeBotTurn(lobby, bot) {
    let active = getActiveParticipants(lobby);
    let curScore = calculateScore(bot.cards);
    let minKnockReq = active.length > 2 ? 21 : 25;
    let canKnock = lobby.gameState === 'playing' && !lobby.knockedBy && (lobby.turnsTakenThisRound >= active.length) && (curScore >= minKnockReq);

    // 7.5 Intelligence Knock Strategy
    if (canKnock) {
        let knockThreshold = curScore >= 28 ? 0.95 : (curScore >= 26 ? 0.80 : 0.35);
        if (Math.random() < knockThreshold) {
            handleKnock(lobby, bot.id);
            return;
        }
    }

    // Draw Strategy (7.5 evaluation)
    let topDiscard = lobby.discardPile[lobby.discardPile.length - 1];
    let shouldDrawDiscard = false;

    if (topDiscard) {
        let scoreWithDiscard = calculateBestFourCardScore([...bot.cards, topDiscard]);
        if (scoreWithDiscard > curScore) {
            shouldDrawDiscard = true;
        } else if (scoreWithDiscard === curScore && topDiscard.points >= 10) {
            let primarySuit = getPrimarySuit(bot.cards);
            if (topDiscard.suit === primarySuit) {
                shouldDrawDiscard = Math.random() < 0.65;
            }
        }
    }

    handleTurnAction(lobby, bot.id, shouldDrawDiscard ? 'DRAW_DISCARD' : 'DRAW_DECK');

    if (lobby.gameState === 'roundOver') return;

    // Discard Phase
    setTimeout(() => {
        let curLobby = lobbies[lobby.code];
        if (!curLobby) return;
        let activeBot = curLobby.players[curLobby.turnIndex];
        if (!activeBot || activeBot.id !== bot.id || activeBot.cards.length !== 4) return;

        let bestDiscardIdx = -1;
        let maxRetainedScore = -1;
        let lowestPointVal = 999;

        for (let i = 0; i < 4; i++) {
            let testHand = activeBot.cards.filter((_, idx) => idx !== i);
            let score = calculateScore(testHand);
            let cardPoint = activeBot.cards[i].points;

            if (score > maxRetainedScore || (score === maxRetainedScore && cardPoint < lowestPointVal)) {
                maxRetainedScore = score;
                lowestPointVal = cardPoint;
                bestDiscardIdx = i;
            }
        }

        handleDiscardAction(curLobby, activeBot.id, bestDiscardIdx !== -1 ? bestDiscardIdx : 0);
    }, 700 + Math.random() * 500);
}

function getPrimarySuit(cards) {
    let suitCounts = {};
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

function buildClientPayload(lobby, wsId, myUsername) {
    let activeParts = getActiveParticipants(lobby);
    let myFedReminder = lobby.fedCardReminders?.[myUsername] || null;
    let myUnrespondedBets = (lobby.pendingBets || []).filter(b => b.target === myUsername);

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        deckCount: lobby.deck.length,
        turnIndex: lobby.turnIndex,
        dealerIndex: lobby.dealerIndex,
        currentTurnUser: lobby.players[lobby.turnIndex]?.username || '',
        phaseMessage: lobby.phaseMessage,
        canKnock: lobby.turnsTakenThisRound >= activeParts.length,
        potTotal: lobby.players.reduce((sum, p) => sum + (p.wager || 5), 0),
        sidePotTotal: (lobby.activeBets || []).reduce((sum, b) => sum + (b.wagerAmt || 0), 0),
        myFedCardReminder: myFedReminder,
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        botBetLedger: lobby.botBetLedger || {},
        pendingBetsForMe: myUnrespondedBets,
        globalProposals: lobby.globalProposals || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        activeParticipantsCount: activeParts.length,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        drawPool: (lobby.drawPool || []).map((c, i) => ({ index: i, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults || {},
        discardTop: lobby.discardPile[lobby.discardPile.length - 1] || null,
        knockedBy: lobby.knockedBy || null,
        chatHistory: lobby.chatHistory || [],
        players: lobby.players.map(p => ({
            username: p.username,
            lives: Math.max(0, p.lives),
            wager: p.wager || 5,
            cardCount: p.cards.length,
            ready: p.ready,
            seat: p.seat,
            nextHandReady: p.nextHandReady,
            eliminated: p.eliminated,
            isBot: !!p.isBot,
            cards: (lobby.gameState === 'roundOver' || p.username === myUsername) ? p.cards : []
        })),
        spectators: lobby.spectators.map(s => ({ username: s.username }))
    };
}

function broadcastLobbyUpdate(code) {
    let lobby = lobbies[code];
    if (!lobby) return;

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.lobbyCode === code) {
            let payload = buildClientPayload(lobby, client.id, client.username);
            client.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: payload }));
        }
    });
}

function broadcastLobbyList() {
    let list = Object.values(lobbies).map(l => ({
        code: l.code,
        name: l.name,
        playerCount: l.players.length,
        maxPlayers: 6,
        gameState: l.gameState
    }));
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'LOBBY_LIST', lobbies: list }));
        }
    });
}

wss.on('connection', (ws) => {
    ws.id = 'ws_' + Math.random().toString(36).substr(2, 9);

    ws.on('message', (message) => {
        try {
            let data = JSON.parse(message);
            let lobby = lobbies[ws.lobbyCode];

            if (data.type === 'CREATE_LOBBY') {
                let code = Math.random().toString(36).substr(2, 5).toUpperCase();
                ws.lobbyCode = code;
                ws.username = data.username || 'Host';

                lobbies[code] = {
                    code: code,
                    name: `${ws.username}'s Game`,
                    host: ws.username,
                    gameState: 'lobby',
                    deck: [],
                    discardPile: [],
                    players: [{
                        id: ws.id,
                        username: ws.username,
                        lives: 2,
                        wager: 5,
                        cards: [],
                        ready: false,
                        nextHandReady: false,
                        seat: 0,
                        eliminated: false,
                        isBot: false
                    }],
                    spectators: [],
                    drawPool: [],
                    drawResults: {},
                    tiedParticipantsList: [],
                    sideBetLedger: {},
                    mainGameLedger: {},
                    botBetLedger: {},
                    activeBets: [],
                    pendingBets: [],
                    globalProposals: [],
                    defaultWager: 5,
                    defaultLives: 2,
                    turnsTakenThisRound: 0,
                    phaseMessage: 'Lobby open. Ready up to begin.'
                };
                broadcastLobbyUpdate(code);
                broadcastLobbyList();
            } else if (data.type === 'JOIN_LOBBY') {
                let joinCode = (data.code || '').trim().toUpperCase();
                let targetLobby = lobbies[joinCode];
                if (!targetLobby) return;

                ws.lobbyCode = joinCode;
                ws.username = data.username || 'Player';

                if (targetLobby.players.length < 6 && targetLobby.gameState === 'lobby') {
                    targetLobby.players.push({
                        id: ws.id,
                        username: ws.username,
                        lives: targetLobby.defaultLives || 2,
                        wager: targetLobby.defaultWager || 5,
                        cards: [],
                        ready: false,
                        nextHandReady: false,
                        seat: getAvailableSeat(targetLobby),
                        eliminated: false,
                        isBot: false
                    });
                } else {
                    targetLobby.spectators.push({ idSocket: ws.id, username: ws.username });
                }
                broadcastLobbyUpdate(joinCode);
                broadcastLobbyList();
            } else if (data.type === 'ADD_BOT') {
                if (!lobby || lobby.players.length >= 6) return;
                let availableNames = BOT_NAMES.filter(n => !lobby.players.some(p => p.username.startsWith(n)));
                let chosenName = (availableNames[Math.floor(Math.random() * availableNames.length)] || ('Bot' + (lobby.players.length + 1))) + ' (B)';
                
                let botPlayer = {
                    id: 'bot_' + Math.random().toString(36).substr(2, 9),
                    username: chosenName,
                    isBot: true,
                    lives: lobby.defaultLives || 2,
                    wager: lobby.defaultWager || 5,
                    cards: [],
                    ready: true,
                    nextHandReady: true,
                    seat: getAvailableSeat(lobby),
                    eliminated: false
                };
                lobby.players.push(botPlayer);
                lobby.phaseMessage = `🤖 ${chosenName} joined the table.`;
                broadcastLobbyUpdate(lobby.code);

                if (lobby.players.length >= 2 && lobby.players.every(p => p.ready)) {
                    startDealerDrawPhase(lobby);
                }
            } else if (data.type === 'REMOVE_BOT') {
                if (!lobby) return;
                let botIdx = -1;
                for (let i = lobby.players.length - 1; i >= 0; i--) {
                    if (lobby.players[i].isBot) {
                        botIdx = i;
                        break;
                    }
                }
                if (botIdx !== -1) {
                    let removed = lobby.players.splice(botIdx, 1)[0];
                    lobby.phaseMessage = `🤖 ${removed.username} was removed.`;
                    broadcastLobbyUpdate(lobby.code);
                }
            } else if (data.type === 'SET_READY') {
                if (!lobby) return;
                let p = lobby.players.find(pl => pl.id === ws.id);
                if (p) {
                    p.ready = !p.ready;
                    broadcastLobbyUpdate(lobby.code);
                    if (lobby.players.length >= 2 && lobby.players.every(pl => pl.ready)) {
                        startDealerDrawPhase(lobby);
                    }
                }
            } else if (data.type === 'NEXT_HAND_READY') {
                if (!lobby) return;
                let p = lobby.players.find(pl => pl.id === ws.id);
                if (p) {
                    p.nextHandReady = true;
                    checkNextHandReady(lobby);
                }
            } else if (data.type === 'CHOOSE_POOL_CARD') {
                if (!lobby) return;
                handlePoolCardSelection(lobby, ws.username, data.cardIndex);
            } else if (data.type === 'DRAW_DECK' || data.type === 'DRAW_DISCARD') {
                if (!lobby) return;
                handleTurnAction(lobby, ws.id, data.type);
            } else if (data.type === 'DISCARD_CARD') {
                if (!lobby) return;
                handleDiscardAction(lobby, ws.id, data.cardIndex);
            } else if (data.type === 'KNOCK') {
                if (!lobby) return;
                handleKnock(lobby, ws.id);
            } else if (data.type === 'PROPOSE_BET') {
                if (!lobby) return;
                let targetPlayer = lobby.players.find(pl => pl.username === data.target);
                if (targetPlayer && targetPlayer.isBot) {
                    let betObj = {
                        id: 'bet_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                        proposer: ws.username,
                        target: targetPlayer.username,
                        type: data.betType,
                        pickUser: data.pickUser,
                        wagerAmt: Number(data.wagerAmt) || 5,
                        isBotBet: true
                    };
                    lobby.activeBets.push(betObj);
                    lobby.phaseMessage = `🤝 Bot Bet Accepted! ${targetPlayer.username} accepted ${ws.username}'s $${betObj.wagerAmt} bet!`;
                    broadcastLobbyUpdate(lobby.code);
                } else if (targetPlayer) {
                    lobby.pendingBets.push({
                        id: 'bet_' + Date.now(),
                        proposer: ws.username,
                        target: targetPlayer.username,
                        type: data.betType,
                        pickUser: data.pickUser,
                        wagerAmt: Number(data.wagerAmt) || 5
                    });
                    broadcastLobbyUpdate(lobby.code);
                }
            } else if (data.type === 'ACCEPT_BET') {
                if (!lobby) return;
                let bIdx = (lobby.pendingBets || []).findIndex(b => b.id === data.betId);
                if (bIdx !== -1) {
                    let bet = lobby.pendingBets.splice(bIdx, 1)[0];
                    lobby.activeBets.push(bet);
                    broadcastLobbyUpdate(lobby.code);
                }
            } else if (data.type === 'DECLINE_BET') {
                if (!lobby) return;
                lobby.pendingBets = (lobby.pendingBets || []).filter(b => b.id !== data.betId);
                broadcastLobbyUpdate(lobby.code);
            } else if (data.type === 'CLEAR_DEBT') {
                if (!lobby) return;
                let debtor = ws.username;
                let creditor = data.targetUser;
                if (data.category === 'bot' && lobby.botBetLedger?.[debtor]) {
                    delete lobby.botBetLedger[debtor][creditor];
                } else if (data.category === 'side' && lobby.sideBetLedger?.[debtor]) {
                    delete lobby.sideBetLedger[debtor][creditor];
                } else if (data.category === 'main' && lobby.mainGameLedger?.[debtor]) {
                    delete lobby.mainGameLedger[debtor][creditor];
                }
                broadcastLobbyUpdate(lobby.code);
            } else if (data.type === 'UPDATE_CONFIG') {
                if (!lobby) return;
                if (data.wager) lobby.defaultWager = parseInt(data.wager);
                if (data.lives) lobby.defaultLives = parseInt(data.lives);
                lobby.players.forEach(p => {
                    p.wager = lobby.defaultWager;
                    p.lives = lobby.defaultLives;
                });
                broadcastLobbyUpdate(lobby.code);
            } else if (data.type === 'LEAVE_LOBBY') {
                if (lobby) {
                    lobby.players = lobby.players.filter(p => p.id !== ws.id);
                    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws.id);
                    if (lobby.players.length === 0) {
                        delete lobbies[ws.lobbyCode];
                    } else {
                        broadcastLobbyUpdate(ws.lobbyCode);
                    }
                    broadcastLobbyList();
                }
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        let lobby = lobbies[ws.lobbyCode];
        if (lobby) {
            lobby.players = lobby.players.filter(p => p.id !== ws.id);
            lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws.id);
            if (lobby.players.length === 0) {
                delete lobbies[ws.lobbyCode];
            } else {
                broadcastLobbyUpdate(ws.lobbyCode);
            }
            broadcastLobbyList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`31! Card Game server running on port ${PORT}`);
});
