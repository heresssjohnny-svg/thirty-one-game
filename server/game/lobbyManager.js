// server/game/lobbyManager.js - PART 2

function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the deck.`;
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        const card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
        currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up ${card.val}${card.suit} from the discard pile!`;

        if (lobby.initialDealCard && card.val === lobby.initialDealCard.val && card.suit === lobby.initialDealCard.suit) {
            lobby.lastDiscardPickup = { username: currentPlayer.username, card: { val: card.val, suit: card.suit } };
        }

        if (lobby.lastDiscardDonor && lobby.lastDiscardDonor !== currentPlayer.username) {
            if (!lobby.fedCardsHistory) lobby.fedCardsHistory = {};
            if (!lobby.fedCardsHistory[currentPlayer.username]) lobby.fedCardsHistory[currentPlayer.username] = {};
            if (!lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor]) {
                lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor] = [];
            }
            lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor].push({
                val: card.val,
                suit: card.suit
            });

            if (!lobby.fedCardReminders) lobby.fedCardReminders = {};
            lobby.fedCardReminders[lobby.lastDiscardDonor] = {
                target: currentPlayer.username,
                card: { val: card.val, suit: card.suit }
            };
        }
    }

    if (calculateBestFourCardScore(currentPlayer.cards) === 31 || calculateScore(currentPlayer.cards) === 31) {
        lobby.hit31Player = currentPlayer.username;

        // Auto-trim 4th card to highest scoring 3-card combination to prevent hand-lock
        if (currentPlayer.cards.length === 4) {
            let bestCards = currentPlayer.cards.slice(0, 3);
            let maxSc = calculateScore(bestCards);
            for (let i = 0; i < 4; i++) {
                const testHand = currentPlayer.cards.filter((_, idx) => idx !== i);
                const sc = calculateScore(testHand);
                if (sc >= maxSc) {
                    maxSc = sc;
                    bestCards = testHand;
                }
            }
            currentPlayer.cards = bestCards;
        }

        const winningSuit = getWinningSuitFor31(currentPlayer.cards);
        const feeder = getFeeder21OutOf31(lobby, currentPlayer, winningSuit);

        if (feeder) {
            feeder.lives = 0;
            feeder.eliminated = true;
            resolveFirstToLoseBets(lobby, feeder.username);
            if (feeder.id && typeof feeder.id === 'object') {
                lobby.spectators.push({ idSocket: feeder.id, username: feeder.username, inVC: feeder.inVC, isMuted: feeder.isMuted });
            }
            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and Face card of ${winningSuit}! Only ${feeder.username} loses all lives!`;
        } else {
            lobby.players.forEach(p => {
                if (p.username !== currentPlayer.username && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        resolveFirstToLoseBets(lobby, p.username);
                        if (p.id && typeof p.id === 'object') {
                            lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                        }
                    }
                }
            });
            lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points! All other players lose a life.`;
        }

        resolveWinSideBets(lobby, currentPlayer.username);

        const remaining = getActiveParticipants(lobby);
        if (remaining.length <= 1) {
            awardTournamentWinner(lobby, remaining[0] || currentPlayer);
            return;
        }

        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, lobby.phaseMessage);
        return;
    }

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleDiscardAction(lobby, wsId, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.cards.length !== 4) return;

    const discarded = currentPlayer.cards[cardIndex];
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
        for (const donor in lobby.fedCardReminders) {
            if (lobby.fedCardReminders[donor].target === currentPlayer.username) {
                const remCard = lobby.fedCardReminders[donor].card;
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
    const score = calculateScore(currentPlayer.cards);
    if (score === 31) {
        lobby.hit31Player = currentPlayer.username;
        const winningSuit = getWinningSuitFor31(currentPlayer.cards);
        const feeder = getFeeder21OutOf31(lobby, currentPlayer, winningSuit);

        if (feeder) {
            feeder.lives = 0;
            feeder.eliminated = true;
            resolveFirstToLoseBets(lobby, feeder.username);
            if (feeder.id && typeof feeder.id === 'object') {
                lobby.spectators.push({ idSocket: feeder.id, username: feeder.username, inVC: feeder.inVC, isMuted: feeder.isMuted });
            }
            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and Face card of ${winningSuit}! Only ${feeder.username} loses all lives!`;
        } else {
            lobby.players.forEach(p => {
                if (p.username !== currentPlayer.username && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        resolveFirstToLoseBets(lobby, p.username);
                        if (p.id && typeof p.id === 'object') {
                            lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                        }
                    }
                }
            });
            lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points! All other players lose a life.`;
        }

        resolveWinSideBets(lobby, currentPlayer.username);

        const remaining = getActiveParticipants(lobby);
        if (remaining.length <= 1) {
            awardTournamentWinner(lobby, remaining[0] || currentPlayer);
            return;
        }

        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, lobby.phaseMessage);
    } else {
        advanceTurnOrResolve(lobby);
    }
}

function handleKnock(lobby, wsId) {
    if (lobby.gameState !== 'playing') return;
    const p = lobby.players[lobby.turnIndex];
    if (!p || p.id !== wsId || lobby.knockedBy) return;

    if (p.cards.length !== 3) {
        return;
    }

    const active = getActiveParticipants(lobby);
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
    const active = getActiveParticipants(lobby);
    const scores = active.map(p => ({ p, s: calculateScore(p.cards) })).sort((a, b) => a.s - b.s);
    const lowest = scores[0].s;
    const tied = scores.filter(s => s.s === lowest);

    if (tied.length > 1) {
        if (active.length === 2) {
            triggerRoundOver(lobby, `Round tied at ${lowest} pts. No one loses a life!`);
        } else {
            lobby.tiedParticipantsList = tied.map(t => t.p.username);
            const tieDeck = (lobby.deck && lobby.deck.length >= tied.length) ? lobby.deck : createDeck();
            lobby.drawPool = tieDeck.map(c => ({ card: c, chosenBy: null }));
            lobby.drawResults = {};
            lobby.drawOrderSequence = [];
            lobby.pendingBotDraw = {};
            lobby.gameState = 'tieBreaker';
            lobby.phaseMessage = `Tie for lowest score (${lowest} pts)! Draw to resolve.`;
            broadcastLobbyUpdate(lobby.code);
            scheduleBotActions(lobby);
        }
    } else {
        const loser = scores[0].p;
        const winner = scores[scores.length - 1].p;
        loser.lives = Math.max(0, loser.lives - 1);

        if (loser.lives <= 0 && !loser.eliminated) {
            loser.eliminated = true;
            resolveFirstToLoseBets(lobby, loser.username);
            if (loser.id && typeof loser.id === 'object') {
                lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
            }
        }

        resolveWinSideBets(lobby, winner.username);

        if (getActiveParticipants(lobby).length <= 1) {
            awardTournamentWinner(lobby, getActiveParticipants(lobby)[0]);
        } else {
            advanceDealerToNextActive(lobby);
            triggerRoundOver(lobby, `Round Over! ${loser.username} had lowest score (${lowest}) and lost a life.`);
        }
    }
}

function triggerRoundOver(lobby, msg) {
    clearRoundOverTimer(lobby);
    lobby.fedCardReminders = {};
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;

    const active = getActiveParticipants(lobby);

    lobby.players.forEach(p => { 
        p.peekAllowed = {};
        p.peekRequests = {};
        p.nextHandReady = p.isBot; 
    });

    broadcastLobbyUpdate(lobby.code);

    if (active.length > 1) {
        lobby.roundOverAutoTimer = setTimeout(() => {
            const cur = lobbies[lobby.code];
            if (!cur || cur.gameState !== 'roundOver') return;

            const remainingActive = getActiveParticipants(cur);
            if (remainingActive.length > 1) {
                cur.players.forEach(p => { p.nextHandReady = true; });
                cur.hit31Player = null;
                broadcastLobbyUpdate(cur.code);
                startRound(cur);
            } else if (remainingActive.length === 1) {
                awardTournamentWinner(cur, remainingActive[0]);
            }
        }, 6000);
    } else if (active.length === 1) {
        awardTournamentWinner(lobby, active[0]);
    }
}

function awardTournamentWinner(lobby, winner) {
    clearRoundOverTimer(lobby);
    if (!winner) return;
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    if (!lobby.botBetLedger) lobby.botBetLedger = {};

    lobby.players.forEach(p => {
        if (p.username !== winner.username) {
            const amt = p.wager || 5;
            const isBotInvolved = p.isBot || winner.isBot;
            const targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.mainGameLedger;

            recordSessionAndLifetimeDebt(lobby, targetLedger, p.username, winner.username, amt);
        }
    });

    lobby.lastGameWinner = winner.username;
    lobby.tournamentWinner = winner.username;
    const winIdx = lobby.players.findIndex(p => p.username === winner.username);
    if (winIdx !== -1) lobby.dealerIndex = winIdx;

    lobby.gameState = 'tournamentEnd';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} wins the match! Ready up in 6s...`;
    broadcastLobbyUpdate(lobby.code);

    setTimeout(() => {
        if (!lobbies[lobby.code]) return;
        resetLobbyToReadyRoom(lobbies[lobby.code], `🏆 ${winner.username} won the match! Ready up for the next game.`);
    }, 6000);
}

function checkNextHandReady(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length <= 1) {
        clearRoundOverTimer(lobby);
        if (active.length === 1) {
            awardTournamentWinner(lobby, active[0]);
        } else {
            resetLobbyToReadyRoom(lobby, "All players eliminated. Returning to ready room.");
        }
        return;
    }

    if (active.every(p => p.nextHandReady)) {
        clearRoundOverTimer(lobby);
        lobby.hit31Player = null;
        startRound(lobby);
    }
}

function resetLobbyToReadyRoom(lobby, msg, broadcastLobbyList) {
    clearRoundOverTimer(lobby);
    lobby.gameState = 'lobby';
    lobby.phaseMessage = msg || "Returned to waiting room.";
    lobby.endGameVotes = {};
    lobby.activeBets = [];
    lobby.pendingBets = [];
    lobby.globalProposals = [];
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;
    lobby.lastDiscardPickup = null;
    lobby.lastDiscardDonor = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.initialDealCard = null;
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};
    lobby.livesVote = null;

    establishDealer(lobby);

    lobby.players.forEach((p, idx) => {
        p.lives = lobby.defaultLives || 2;
        p.eliminated = false;
        p.cards = [];
        p.ready = false;
        p.seat = idx;
        p.nextHandReady = false;
        p.peekRequests = {};
        p.peekAllowed = {};
    });

    lobby.spectators = lobby.spectators.filter(s => {
        return s.idSocket && s.idSocket.readyState === WebSocket.OPEN;
    });

    syncBotReadiness(lobby);
    broadcastLobbyUpdate(lobby.code);
    if (broadcastLobbyList) broadcastLobbyList();
}

function scheduleBotActions(lobby) {
    if (!lobby) return;
    if (!lobby.pendingBotDraw) lobby.pendingBotDraw = {};

    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
        lobby.players.forEach(p => {
            if (p.isBot && !p.eliminated) {
                let needsPick = false;
                if (lobby.gameState === 'dealerDraw' && !lobby.drawResults[p.username]) needsPick = true;
                if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.includes(p.username) && !lobby.drawResults[p.username]) needsPick = true;

                if (needsPick && !lobby.pendingBotDraw[p.username]) {
                    lobby.pendingBotDraw[p.username] = true;
                    setTimeout(() => {
                        const cur = lobbies[lobby.code];
                        if (!cur) return;
                        delete cur.pendingBotDraw[p.username];

                        if (cur.gameState !== 'dealerDraw' && cur.gameState !== 'tieBreaker') return;
                        if (cur.drawResults && cur.drawResults[p.username]) return;
                        if (cur.gameState === 'tieBreaker' && !cur.tiedParticipantsList.includes(p.username)) return;

                        const unchosen = cur.drawPool.map((c, i) => ({ i, chosen: c.chosenBy })).filter(c => c.chosen === null);
                        if (unchosen.length > 0) {
                            const chosenIndex = unchosen[Math.floor(Math.random() * unchosen.length)].i;
                            handlePoolCardSelection(cur, p.username, chosenIndex);
                        }
                    }, 500 + Math.random() * 600);
                }
            }
        });
        return;
    }

    if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
        const cur = lobby.players[lobby.turnIndex];
        if (!cur || !cur.isBot || cur.eliminated) return;

        setTimeout(() => {
            const curLobby = lobbies[lobby.code];
            if (!curLobby || (curLobby.gameState !== 'playing' && curLobby.gameState !== 'finalTurn')) return;
            const bot = curLobby.players[curLobby.turnIndex];
            if (!bot || bot.id !== cur.id) return;

            executeBotTurn(curLobby, bot, {
                handleKnock,
                handleTurnAction,
                handleDiscardAction
            });
        }, 700 + Math.random() * 500);
    }
}

function leaveLobby(ws, code, broadcastLobbyList) {
    if (!lobbies[code]) return;
    const lobby = lobbies[code];

    const leavingPlayerIndex = lobby.players.findIndex(p => p.id === ws);
    const leavingUsername = leavingPlayerIndex !== -1 ? lobby.players[leavingPlayerIndex].username : null;

    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);

    const remainingHumans = lobby.players.filter(p => !p.isBot);
    if (remainingHumans.length === 0) {
        clearRoundOverTimer(lobby);
        if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
        delete lobbies[code];
        if (broadcastLobbyList) broadcastLobbyList();
        return;
    }

    lobby.players.forEach((p, idx) => { p.seat = idx; });

    if (lobby.gameState === 'roundOver') {
        lobby.phaseMessage = `${leavingUsername || 'A player'} left the game.`;
        checkNextHandReady(lobby);
        broadcastLobbyUpdate(code);
        if (broadcastLobbyList) broadcastLobbyList();
        return;
    }

    const activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1 && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn' || lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker')) {
        awardTournamentWinner(lobby, activeParts[0]);
    } else {
        if (lobby.turnIndex >= lobby.players.length) {
            lobby.turnIndex = 0;
        }
        establishDealer(lobby);
        syncBotReadiness(lobby);
        broadcastLobbyUpdate(code);
    }

    if (broadcastLobbyList) broadcastLobbyList();
}

module.exports = {
    lobbies,
    getLobbies,
    getActiveParticipants,
    findOpenSeat,
    touchLobbyActivity,
    closeInactiveLobby,
    getPublicLobbiesList,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    startDealerDrawPhase,
    startRound,
    advanceDealerToNextActive,
    handlePoolCardSelection,
    handleTurnAction,
    handleDiscardAction,
    handleKnock,
    checkNextHandReady,
    resetLobbyToReadyRoom,
    scheduleBotActions,
    leaveLobby,
    resolveUserId,
    recordSessionAndLifetimeDebt
};
// server/game/lobbyManager.js - PART 2

function handleTurnAction(lobby, wsId, actionType) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.eliminated || currentPlayer.cards.length >= 4) return;

    if (actionType === 'DRAW_DECK') {
        if (lobby.deck.length === 0) lobby.deck = createDeck();
        currentPlayer.cards.push(lobby.deck.pop());
        currentPlayer.pickedUpDiscardCard = null;
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up a card from the deck.`;
    } else if (actionType === 'DRAW_DISCARD' && lobby.discardPile.length > 0) {
        const card = lobby.discardPile.pop();
        currentPlayer.cards.push(card);
        currentPlayer.pickedUpDiscardCard = { val: card.val, suit: card.suit };
        lobby.phaseMessage = `📢 ${currentPlayer.username} picked up ${card.val}${card.suit} from the discard pile!`;

        if (lobby.initialDealCard && card.val === lobby.initialDealCard.val && card.suit === lobby.initialDealCard.suit) {
            lobby.lastDiscardPickup = { username: currentPlayer.username, card: { val: card.val, suit: card.suit } };
        }

        if (lobby.lastDiscardDonor && lobby.lastDiscardDonor !== currentPlayer.username) {
            if (!lobby.fedCardsHistory) lobby.fedCardsHistory = {};
            if (!lobby.fedCardsHistory[currentPlayer.username]) lobby.fedCardsHistory[currentPlayer.username] = {};
            if (!lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor]) {
                lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor] = [];
            }
            lobby.fedCardsHistory[currentPlayer.username][lobby.lastDiscardDonor].push({
                val: card.val,
                suit: card.suit
            });

            if (!lobby.fedCardReminders) lobby.fedCardReminders = {};
            lobby.fedCardReminders[lobby.lastDiscardDonor] = {
                target: currentPlayer.username,
                card: { val: card.val, suit: card.suit }
            };
        }
    }

    if (calculateBestFourCardScore(currentPlayer.cards) === 31 || calculateScore(currentPlayer.cards) === 31) {
        lobby.hit31Player = currentPlayer.username;

        // Auto-trim 4th card to highest scoring 3-card combination to prevent 4-card freeze
        if (currentPlayer.cards.length === 4) {
            let bestCards = currentPlayer.cards.slice(0, 3);
            let maxSc = calculateScore(bestCards);
            for (let i = 0; i < 4; i++) {
                const testHand = currentPlayer.cards.filter((_, idx) => idx !== i);
                const sc = calculateScore(testHand);
                if (sc >= maxSc) {
                    maxSc = sc;
                    bestCards = testHand;
                }
            }
            currentPlayer.cards = bestCards;
        }

        const winningSuit = getWinningSuitFor31(currentPlayer.cards);
        const feeder = getFeeder21OutOf31(lobby, currentPlayer, winningSuit);

        if (feeder) {
            feeder.lives = 0;
            feeder.eliminated = true;
            resolveFirstToLoseBets(lobby, feeder.username);
            if (feeder.id && typeof feeder.id === 'object') {
                lobby.spectators.push({ idSocket: feeder.id, username: feeder.username, inVC: feeder.inVC, isMuted: feeder.isMuted });
            }
            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and Face card of ${winningSuit}! Only ${feeder.username} loses all lives!`;
        } else {
            lobby.players.forEach(p => {
                if (p.username !== currentPlayer.username && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        resolveFirstToLoseBets(lobby, p.username);
                        if (p.id && typeof p.id === 'object') {
                            lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                        }
                    }
                }
            });
            lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points! All other players lose a life.`;
        }

        resolveWinSideBets(lobby, currentPlayer.username);

        const remaining = getActiveParticipants(lobby);
        if (remaining.length <= 1) {
            awardTournamentWinner(lobby, remaining[0] || currentPlayer);
            return;
        }

        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, lobby.phaseMessage);
        return;
    }

    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function handleDiscardAction(lobby, wsId, cardIndex) {
    if (lobby.gameState !== 'playing' && lobby.gameState !== 'finalTurn') return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (!currentPlayer || currentPlayer.id !== wsId || currentPlayer.cards.length !== 4) return;

    // Safety guard on index
    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= currentPlayer.cards.length) {
        cardIndex = 0;
    }

    const discarded = currentPlayer.cards[cardIndex];
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
        for (const donor in lobby.fedCardReminders) {
            if (lobby.fedCardReminders[donor].target === currentPlayer.username) {
                const remCard = lobby.fedCardReminders[donor].card;
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
    const score = calculateScore(currentPlayer.cards);
    if (score === 31) {
        lobby.hit31Player = currentPlayer.username;
        const winningSuit = getWinningSuitFor31(currentPlayer.cards);
        const feeder = getFeeder21OutOf31(lobby, currentPlayer, winningSuit);

        if (feeder) {
            feeder.lives = 0;
            feeder.eliminated = true;
            resolveFirstToLoseBets(lobby, feeder.username);
            if (feeder.id && typeof feeder.id === 'object') {
                lobby.spectators.push({ idSocket: feeder.id, username: feeder.username, inVC: feeder.inVC, isMuted: feeder.isMuted });
            }
            lobby.phaseMessage = `💥 21 OUT OF 31 RULE! ${feeder.username} fed ${currentPlayer.username} an Ace and Face card of ${winningSuit}! Only ${feeder.username} loses all lives!`;
        } else {
            lobby.players.forEach(p => {
                if (p.username !== currentPlayer.username && !p.eliminated) {
                    p.lives = Math.max(0, p.lives - 1);
                    if (p.lives <= 0) {
                        p.eliminated = true;
                        resolveFirstToLoseBets(lobby, p.username);
                        if (p.id && typeof p.id === 'object') {
                            lobby.spectators.push({ idSocket: p.id, username: p.username, inVC: p.inVC, isMuted: p.isMuted });
                        }
                    }
                }
            });
            lobby.phaseMessage = `⚡ 31! ${currentPlayer.username} hit 31 points! All other players lose a life.`;
        }

        resolveWinSideBets(lobby, currentPlayer.username);

        const remaining = getActiveParticipants(lobby);
        if (remaining.length <= 1) {
            awardTournamentWinner(lobby, remaining[0] || currentPlayer);
            return;
        }

        advanceDealerToNextActive(lobby);
        triggerRoundOver(lobby, lobby.phaseMessage);
    } else {
        advanceTurnOrResolve(lobby);
    }
}

function handleKnock(lobby, wsId) {
    if (lobby.gameState !== 'playing') return;
    const p = lobby.players[lobby.turnIndex];
    if (!p || p.id !== wsId || lobby.knockedBy) return;

    if (p.cards.length !== 3) {
        return;
    }

    const active = getActiveParticipants(lobby);
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
    // Trim any players still holding 4 cards to their best 3
    lobby.players.forEach(p => {
        if (p.cards && p.cards.length === 4) {
            let bestCards = p.cards.slice(0, 3);
            let maxSc = calculateScore(bestCards);
            for (let i = 0; i < 4; i++) {
                const testHand = p.cards.filter((_, idx) => idx !== i);
                const sc = calculateScore(testHand);
                if (sc >= maxSc) {
                    maxSc = sc;
                    bestCards = testHand;
                }
            }
            p.cards = bestCards;
        }
    });

    const active = getActiveParticipants(lobby);
    const scores = active.map(p => ({ p, s: calculateScore(p.cards) })).sort((a, b) => a.s - b.s);
    const lowest = scores[0].s;
    const tied = scores.filter(s => s.s === lowest);

    if (tied.length > 1) {
        if (active.length === 2) {
            triggerRoundOver(lobby, `Round tied at ${lowest} pts. No one loses a life!`);
        } else {
            lobby.tiedParticipantsList = tied.map(t => t.p.username);
            const tieDeck = (lobby.deck && lobby.deck.length >= tied.length) ? lobby.deck : createDeck();
            lobby.drawPool = tieDeck.map(c => ({ card: c, chosenBy: null }));
            lobby.drawResults = {};
            lobby.drawOrderSequence = [];
            lobby.pendingBotDraw = {};
            lobby.gameState = 'tieBreaker';
            lobby.phaseMessage = `Tie for lowest score (${lowest} pts)! Draw to resolve.`;
            broadcastLobbyUpdate(lobby.code);
            scheduleBotActions(lobby);
        }
    } else {
        const loser = scores[0].p;
        const winner = scores[scores.length - 1].p;
        loser.lives = Math.max(0, loser.lives - 1);

        if (loser.lives <= 0 && !loser.eliminated) {
            loser.eliminated = true;
            resolveFirstToLoseBets(lobby, loser.username);
            if (loser.id && typeof loser.id === 'object') {
                lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
            }
        }

        resolveWinSideBets(lobby, winner.username);

        if (getActiveParticipants(lobby).length <= 1) {
            awardTournamentWinner(lobby, getActiveParticipants(lobby)[0]);
        } else {
            advanceDealerToNextActive(lobby);
            triggerRoundOver(lobby, `Round Over! ${loser.username} had lowest score (${lowest}) and lost a life.`);
        }
    }
}

function triggerRoundOver(lobby, msg) {
    clearRoundOverTimer(lobby);
    lobby.fedCardReminders = {};
    lobby.gameState = 'roundOver';
    lobby.phaseMessage = msg;

    const active = getActiveParticipants(lobby);

    lobby.players.forEach(p => { 
        p.peekAllowed = {};
        p.peekRequests = {};
        p.nextHandReady = p.isBot; 
    });

    broadcastLobbyUpdate(lobby.code);

    if (active.length > 1) {
        lobby.roundOverAutoTimer = setTimeout(() => {
            const cur = lobbies[lobby.code];
            if (!cur || cur.gameState !== 'roundOver') return;

            const remainingActive = getActiveParticipants(cur);
            if (remainingActive.length > 1) {
                cur.players.forEach(p => { p.nextHandReady = true; });
                cur.hit31Player = null;
                broadcastLobbyUpdate(cur.code);
                startRound(cur);
            } else if (remainingActive.length === 1) {
                awardTournamentWinner(cur, remainingActive[0]);
            }
        }, 6000);
    } else if (active.length === 1) {
        awardTournamentWinner(lobby, active[0]);
    }
}

function awardTournamentWinner(lobby, winner) {
    clearRoundOverTimer(lobby);
    if (!winner) return;
    if (!lobby.mainGameLedger) lobby.mainGameLedger = {};
    if (!lobby.botBetLedger) lobby.botBetLedger = {};

    lobby.players.forEach(p => {
        if (p.username !== winner.username) {
            const amt = p.wager || 5;
            const isBotInvolved = p.isBot || winner.isBot;
            const targetLedger = isBotInvolved ? lobby.botBetLedger : lobby.mainGameLedger;

            recordSessionAndLifetimeDebt(lobby, targetLedger, p.username, winner.username, amt);
        }
    });

    lobby.lastGameWinner = winner.username;
    lobby.tournamentWinner = winner.username;
    const winIdx = lobby.players.findIndex(p => p.username === winner.username);
    if (winIdx !== -1) lobby.dealerIndex = winIdx;

    lobby.gameState = 'tournamentEnd';
    lobby.phaseMessage = `🏆 TOURNAMENT WINNER! ${winner.username} wins the match! Ready up in 6s...`;
    broadcastLobbyUpdate(lobby.code);

    setTimeout(() => {
        if (!lobbies[lobby.code]) return;
        resetLobbyToReadyRoom(lobbies[lobby.code], `🏆 ${winner.username} won the match! Ready up for the next game.`);
    }, 6000);
}

function checkNextHandReady(lobby) {
    const active = getActiveParticipants(lobby);
    if (active.length <= 1) {
        clearRoundOverTimer(lobby);
        if (active.length === 1) {
            awardTournamentWinner(lobby, active[0]);
        } else {
            resetLobbyToReadyRoom(lobby, "All players eliminated. Returning to ready room.");
        }
        return;
    }

    if (active.every(p => p.nextHandReady)) {
        clearRoundOverTimer(lobby);
        lobby.hit31Player = null;
        startRound(lobby);
    }
}

function resetLobbyToReadyRoom(lobby, msg, broadcastLobbyList) {
    clearRoundOverTimer(lobby);
    lobby.gameState = 'lobby';
    lobby.phaseMessage = msg || "Returned to waiting room.";
    lobby.endGameVotes = {};
    lobby.activeBets = [];
    lobby.pendingBets = [];
    lobby.globalProposals = [];
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;
    lobby.lastDiscardPickup = null;
    lobby.lastDiscardDonor = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.initialDealCard = null;
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};
    lobby.livesVote = null;

    establishDealer(lobby);

    lobby.players.forEach((p, idx) => {
        p.lives = lobby.defaultLives || 2;
        p.eliminated = false;
        p.cards = [];
        p.ready = false;
        p.seat = idx;
        p.nextHandReady = false;
        p.peekRequests = {};
        p.peekAllowed = {};
    });

    lobby.spectators = lobby.spectators.filter(s => {
        return s.idSocket && s.idSocket.readyState === WebSocket.OPEN;
    });

    syncBotReadiness(lobby);
    broadcastLobbyUpdate(lobby.code);
    if (broadcastLobbyList) broadcastLobbyList();
}

function scheduleBotActions(lobby) {
    if (!lobby) return;
    if (!lobby.pendingBotDraw) lobby.pendingBotDraw = {};

    if (lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker') {
        lobby.players.forEach(p => {
            if (p.isBot && !p.eliminated) {
                let needsPick = false;
                if (lobby.gameState === 'dealerDraw' && !lobby.drawResults[p.username]) needsPick = true;
                if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.includes(p.username) && !lobby.drawResults[p.username]) needsPick = true;

                if (needsPick && !lobby.pendingBotDraw[p.username]) {
                    lobby.pendingBotDraw[p.username] = true;
                    setTimeout(() => {
                        const cur = lobbies[lobby.code];
                        if (!cur) return;
                        delete cur.pendingBotDraw[p.username];

                        if (cur.gameState !== 'dealerDraw' && cur.gameState !== 'tieBreaker') return;
                        if (cur.drawResults && cur.drawResults[p.username]) return;
                        if (cur.gameState === 'tieBreaker' && !cur.tiedParticipantsList.includes(p.username)) return;

                        const unchosen = cur.drawPool.map((c, i) => ({ i, chosen: c.chosenBy })).filter(c => c.chosen === null);
                        if (unchosen.length > 0) {
                            const chosenIndex = unchosen[Math.floor(Math.random() * unchosen.length)].i;
                            handlePoolCardSelection(cur, p.username, chosenIndex);
                        }
                    }, 500 + Math.random() * 600);
                }
            }
        });
        return;
    }

    if (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') {
        const cur = lobby.players[lobby.turnIndex];
        if (!cur || !cur.isBot || cur.eliminated) return;

        setTimeout(() => {
            const curLobby = lobbies[lobby.code];
            if (!curLobby || (curLobby.gameState !== 'playing' && curLobby.gameState !== 'finalTurn')) return;
            const bot = curLobby.players[curLobby.turnIndex];
            if (!bot || bot.id !== cur.id) return;

            executeBotTurn(curLobby, bot, {
                handleKnock,
                handleTurnAction,
                handleDiscardAction
            });
        }, 700 + Math.random() * 500);
    }
}

function leaveLobby(ws, code, broadcastLobbyList) {
    if (!lobbies[code]) return;
    const lobby = lobbies[code];

    const leavingPlayerIndex = lobby.players.findIndex(p => p.id === ws);
    const leavingUsername = leavingPlayerIndex !== -1 ? lobby.players[leavingPlayerIndex].username : null;

    lobby.players = lobby.players.filter(p => p.id !== ws);
    lobby.spectators = lobby.spectators.filter(s => s.idSocket !== ws);

    const remainingHumans = lobby.players.filter(p => !p.isBot);
    if (remainingHumans.length === 0) {
        clearRoundOverTimer(lobby);
        if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
        delete lobbies[code];
        if (broadcastLobbyList) broadcastLobbyList();
        return;
    }

    lobby.players.forEach((p, idx) => { p.seat = idx; });

    if (lobby.gameState === 'roundOver') {
        lobby.phaseMessage = `${leavingUsername || 'A player'} left the game.`;
        checkNextHandReady(lobby);
        broadcastLobbyUpdate(code);
        if (broadcastLobbyList) broadcastLobbyList();
        return;
    }

    const activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1 && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn' || lobby.gameState === 'dealerDraw' || lobby.gameState === 'tieBreaker')) {
        awardTournamentWinner(lobby, activeParts[0]);
    } else {
        if (lobby.turnIndex >= lobby.players.length) {
            lobby.turnIndex = 0;
        }
        establishDealer(lobby);
        syncBotReadiness(lobby);
        broadcastLobbyUpdate(code);
    }

    if (broadcastLobbyList) broadcastLobbyList();
}

module.exports = {
    lobbies,
    getLobbies,
    getActiveParticipants,
    findOpenSeat,
    touchLobbyActivity,
    closeInactiveLobby,
    getPublicLobbiesList,
    getSanitizedLobby,
    broadcastLobbyUpdate,
    startDealerDrawPhase,
    startRound,
    advanceDealerToNextActive,
    handlePoolCardSelection,
    handleTurnAction,
    handleDiscardAction,
    handleKnock,
    checkNextHandReady,
    resetLobbyToReadyRoom,
    scheduleBotActions,
    leaveLobby,
    resolveUserId,
    recordSessionAndLifetimeDebt
};
