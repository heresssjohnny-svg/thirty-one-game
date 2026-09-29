const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('Could not locate index.html');
});

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 10, 'Q': 10, 'K': 10, 'A': 11
};

const CUT_RANKS = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

const MAX_ACTIVE_PLAYERS = 6;
const rooms = {};
const disconnectTimeouts = {};

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ rank: r, suit: s, value: VALUES[r] });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calculateScore(hand) {
  if (!hand || hand.length === 0) return 0;

  if (hand.length === 3) {
    if (hand[0].rank === hand[1].rank && hand[1].rank === hand[2].rank) return 30.5;
  } else if (hand.length === 4) {
    const counts = {};
    for (const c of hand) {
      counts[c.rank] = (counts[c.rank] || 0) + 1;
      if (counts[c.rank] >= 3) return 30.5;
    }
  }

  const totals = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
  for (const c of hand) {
    totals[c.suit] += c.value;
  }
  return Math.max(...Object.values(totals));
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.isSpectator && p.lives > 0);
}

function getNonSpectatorCount(room) {
  return room.players.filter(p => !p.isSpectator).length;
}

function advanceTurnIndex(room) {
  const total = room.players.length;
  if (total === 0) return;

  for (let step = 1; step <= total; step++) {
    const nextIdx = (room.currentTurnIdx + step) % total;
    const candidate = room.players[nextIdx];
    if (candidate && !candidate.isSpectator && candidate.lives > 0) {
      room.currentTurnIdx = nextIdx;
      while (candidate.hand && candidate.hand.length < 3 && room.deck && room.deck.length > 0) {
        candidate.hand.push(room.deck.pop());
      }
      return;
    }
  }
}

function getPrevActivePlayer(room, currentIdx) {
  const total = room.players.length;
  for (let step = 1; step <= total; step++) {
    const prevIdx = (currentIdx - step + total) % total;
    const candidate = room.players[prevIdx];
    if (candidate && !candidate.isSpectator && candidate.lives > 0) {
      return candidate;
    }
  }
  return null;
}

function checkAllPlayersReady(room) {
  const eligible = room.players.filter(p => !p.isSpectator && (room.gameStarted ? p.lives > 0 : true));
  if (eligible.length < 2) return false;
  return eligible.every(p => p.isReady || p.isBot);
}

function getRevealedHands(room) {
  return getActivePlayers(room).map(p => ({
    name: p.name,
    score: calculateScore(p.hand),
    hand: p.hand,
    isKnocker: room.knockerId === p.id
  }));
}

function recordDebt(room, debtorName, creditorName, amount) {
  if (debtorName === creditorName || amount <= 0) return;
  if (!room.debts[debtorName]) room.debts[debtorName] = {};
  room.debts[debtorName][creditorName] = (room.debts[debtorName][creditorName] || 0) + amount;
}

function getNetPairBalance(room, p1Name, p2Name) {
  const p2OwesP1 = (room.debts[p2Name] && room.debts[p2Name][p1Name]) || 0;
  const p1OwesP2 = (room.debts[p1Name] && room.debts[p1Name][p2Name]) || 0;
  return p2OwesP1 - p1OwesP2;
}

function getPersonalLedger(room, playerName) {
  const ledger = [];
  let totalNet = 0;

  const allNames = new Set();
  room.players.forEach(p => allNames.add(p.name));
  Object.keys(room.debts).forEach(name => {
    allNames.add(name);
    Object.keys(room.debts[name] || {}).forEach(target => allNames.add(target));
  });

  allNames.forEach(otherName => {
    if (otherName === playerName) return;
    const net = getNetPairBalance(room, playerName, otherName);
    totalNet += net;
    ledger.push({
      player: otherName,
      netBalance: net
    });
  });

  ledger.sort((a, b) => b.netBalance - a.netBalance);

  return {
    balances: ledger,
    totalNet: totalNet
  };
}

function recordGameWagerSettlement(room, winner) {
  if (!winner || !room.currentMatchParticipants) return 0;
  
  const winnerData = room.currentMatchParticipants.find(p => p.id === winner.id || p.name === winner.name);
  if (!winnerData || winnerData.wager <= 0) return 0;

  let totalCollected = 0;

  room.currentMatchParticipants.forEach(loserData => {
    if (loserData.name !== winnerData.name) {
      const amountToCollect = Math.min(winnerData.wager, loserData.wager);
      if (amountToCollect > 0) {
        recordDebt(room, loserData.name, winnerData.name, amountToCollect);
        totalCollected += amountToCollect;
      }
    }
  });

  return totalCollected;
}

function settleRoundBets(room, winningPlayers) {
  if (!room.roundBets || room.roundBets.length === 0) return '';
  if (!winningPlayers || winningPlayers.length === 0) {
    room.roundBets = [];
    return '';
  }

  const winningPlayerNames = new Set(winningPlayers.map(p => p.name));
  const winningBets = room.roundBets.filter(b => winningPlayerNames.has(b.targetPlayerName));
  const losingBets = room.roundBets.filter(b => !winningPlayerNames.has(b.targetPlayerName));
  const totalPot = room.roundBets.reduce((sum, b) => sum + b.amount, 0);

  if (winningBets.length === 0) {
    room.roundBets = [];
    return `Round side bets ($${totalPot} pot) pushed!`;
  }

  const winningStakesTotal = winningBets.reduce((sum, b) => sum + b.amount, 0);
  const sideBetWinners = [];

  winningBets.forEach(wBet => {
    const netWin = Math.round((wBet.amount / winningStakesTotal) * (totalPot - winningStakesTotal));
    sideBetWinners.push(`${wBet.bettorName} (+$${netWin})`);

    losingBets.forEach(lBet => {
      const shareOwed = Math.round((lBet.amount / totalPot) * (wBet.amount + netWin));
      if (shareOwed > 0) {
        recordDebt(room, lBet.bettorName, wBet.bettorName, shareOwed);
      }
    });
  });

  room.roundBets = [];
  return `Side Bet Winners: ${sideBetWinners.join(', ')}`;
}

function broadcastRoomList() {
  const roomList = Object.entries(rooms).map(([id, r]) => {
    const activeCount = r.players.filter(p => !p.isSpectator).length;
    const specCount = r.players.filter(p => p.isSpectator).length;
    
    let totalPot = 0;
    if (r.gameStarted && r.currentMatchParticipants) {
      totalPot = r.currentMatchParticipants.reduce((sum, p) => sum + p.wager, 0);
    } else {
      totalPot = getActivePlayers(r).reduce((sum, p) => sum + (p.matchWager || 0), 0);
    }

    return {
      roomId: id,
      gameStarted: r.gameStarted,
      activeCount: activeCount,
      spectatorCount: specCount,
      totalPot: totalPot
    };
  });
  io.emit('roomListUpdate', roomList);
}

function startInteractiveTiebreaker(room, tiedPlayers, sideBetReport) {
  room.tiebreakerActive = true;
  room.tiebreakerPicks = {};
  room.tiedPlayerIds = tiedPlayers.map(p => p.id);

  let eligibleDeck = [...room.deck];
  if (eligibleDeck.length < 15) {
    const top = room.discardPile.pop();
    eligibleDeck = eligibleDeck.concat(room.discardPile.sort(() => Math.random() - 0.5));
    room.discardPile = [top];
  }
  room.tiebreakerDeck = eligibleDeck.sort(() => Math.random() - 0.5);

  io.to(room.id).emit('startTiebreakerCut', {
    deckCount: room.tiebreakerDeck.length,
    tiedPlayers: tiedPlayers.map(p => ({ id: p.id, name: p.name })),
    sideBetReport: sideBetReport || ''
  });

  tiedPlayers.forEach(p => {
    if (p.isBot) {
      setTimeout(() => {
        if (!room.tiebreakerActive || room.tiebreakerPicks[p.id]) return;
        const chosenCardIdx = Math.floor(Math.random() * room.tiebreakerDeck.length);
        const card = room.tiebreakerDeck.splice(chosenCardIdx, 1)[0];
        room.tiebreakerPicks[p.id] = { player: p, card: card };

        io.to(room.id).emit('tiebreakerCardPicked', {
          playerId: p.id,
          playerName: p.name,
          remainingCount: room.tiebreakerDeck.length
        });

        checkTiebreakerComplete(room);
      }, 1000 + Math.random() * 800);
    }
  });
}

function checkTiebreakerComplete(room) {
  const requiredCount = room.tiedPlayerIds.length;
  const pickedCount = Object.keys(room.tiebreakerPicks).length;
  if (pickedCount < requiredCount) return;

  room.tiebreakerActive = false;
  const picks = Object.values(room.tiebreakerPicks);

  let minCardVal = 99;
  let cutLosers = [];
  const revealData = [];

  picks.forEach(item => {
    const rankVal = CUT_RANKS[item.card.rank];
    revealData.push({
      id: item.player.id,
      name: item.player.name,
      card: item.card,
      rankVal: rankVal
    });

    if (rankVal < minCardVal) {
      minCardVal = rankVal;
      cutLosers = [item];
    } else if (rankVal === minCardVal) {
      cutLosers.push(item);
    }
  });

  io.to(room.id).emit('tiebreakerResultsReveal', {
    results: revealData
  });

  if (cutLosers.length > 1) {
    setTimeout(() => {
      io.to(room.id).emit('bannerAnnouncement', {
        text: `Tie for lowest cut! Re-drawing lowest players...`,
        duration: 2500
      });
      startInteractiveTiebreaker(room, cutLosers.map(l => l.player), 'Re-drawing lowest cards');
    }, 2800);
    return;
  }

  const ultimateLoser = cutLosers[0];
  ultimateLoser.player.lives -= 1;

  setTimeout(() => {
    io.to(room.id).emit('bigAnnouncement', {
      title: '⚡ TIEBREAKER FINISHED! ⚡',
      message: `LOSER: ${ultimateLoser.player.name.toUpperCase()} (${ultimateLoser.card.rank}${ultimateLoser.card.suit})`,
      subtext: `Picked lowest card from the deck!`,
      hands: getRevealedHands(room),
      duration: 6500
    });

    broadcastState(room.id, `Tiebreaker Cut: ${ultimateLoser.player.name} picked the lowest card (${ultimateLoser.card.rank}${ultimateLoser.card.suit}) and lost a life!`);
    setTimeout(() => startNewRound(room.id), 6500);
  }, 3200);
}

function checkAndHandle31(room, player) {
  if (calculateScore(player.hand) !== 31) return false;
  if (room.isResolvingRound) return true;
  room.isResolvingRound = true;

  let penalizedGiver = null;
  const revealedHands = getRevealedHands(room);
  const sideBetReport = settleRoundBets(room, [player]);

  if (player.lastDrawnSource === 'discard' && player.fedCardsTracker) {
    for (const [giverId, cards] of Object.entries(player.fedCardsTracker)) {
      const cardsInHandFromGiver = cards.filter(c => 
        player.hand.some(hCard => hCard.rank === c.rank && hCard.suit === c.suit)
      );

      const hasAce = cardsInHandFromGiver.some(c => c.rank === 'A');
      const hasTen = cardsInHandFromGiver.some(c => c.value === 10);

      if (hasAce && hasTen) {
        penalizedGiver = room.players.find(p => p.id === giverId && p.lives > 0);
        if (penalizedGiver) break;
      }
    }
  }

  if (penalizedGiver) {
    penalizedGiver.lives = Math.max(0, penalizedGiver.lives - 2);
    broadcastState(room.id);

    io.to(room.id).emit('bigAnnouncement', {
      title: '⚡ 31 HIT FROM DISCARD! ⚡',
      message: `LOSER: ${penalizedGiver.name.toUpperCase()} LOST 2 LIVES!`,
      subtext: `${sideBetReport ? sideBetReport + ' | ' : ''}Fed Ace & 10 to ${player.name}!`,
      hands: revealedHands,
      duration: 6500
    });
  } else {
    const losers = [];
    room.players.forEach(p => {
      if (!p.isSpectator && p.lives > 0 && p.id !== player.id) {
        p.lives -= 1;
        losers.push(p.name);
      }
    });

    broadcastState(room.id);

    const drawDesc = player.lastDrawnSource === 'deck' 
      ? 'Drawn from Deck!' 
      : (player.lastDrawnSource === 'deal' ? 'Dealt 31!' : 'Natural 31!');

    io.to(room.id).emit('bigAnnouncement', {
      title: `⚡ ${player.name.toUpperCase()} HIT 31! ⚡`,
      message: `EVERYONE ELSE LOSES 1 LIFE!`,
      subtext: `${sideBetReport ? sideBetReport + ' | ' : ''}${drawDesc} Losers: ${losers.join(', ')}`,
      hands: revealedHands,
      duration: 6500
    });
  }

  setTimeout(() => startNewRound(room.id), 6500);
  return true;
}

function startNewRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActivePlayers(room);
  if (active.length <= 1) {
    const winner = active[0] || null;
    const winnerName = winner ? winner.name : 'Nobody';

    let potWonText = '';
    if (winner) {
      const totalCollected = recordGameWagerSettlement(room, winner);
      if (totalCollected > 0) {
        potWonText = ` Takes $${totalCollected} from the pot!`;
      }
    }

    io.to(roomId).emit('bigAnnouncement', {
      title: '🏆 GAME OVER 🏆',
      message: `${winnerName.toUpperCase()} WINS!${potWonText}`,
      subtext: 'Check Ledger for updated balances with each player.',
      duration: 8000
    });

    room.gameStarted = false;
    room.currentMatchParticipants = [];
    room.roundBets = [];

    let activeAssigned = 0;
    room.players.forEach(p => { 
      if (!p.manualSpectator && activeAssigned < MAX_ACTIVE_PLAYERS) {
        p.isSpectator = false;
        p.lives = 2;
        activeAssigned++;
      } else {
        p.isSpectator = true;
        p.lives = 0;
      }
      p.isReady = false; 
    });

    broadcastState(roomId, `Game over! ${winnerName} won! Check Ledger for balances.`);
    broadcastRoomList();
    return;
  }

  room.players.forEach(p => { p.isReady = false; });

  room.deck = createDeck();
  room.discardPile = [];
  room.knockerId = null;
  room.turnsLeftAfterKnock = null;
  room.drawnCard = null;
  room.isResolvingRound = false;
  room.turnsTakenInRound = 0;
  room.currentDiscardFeederId = null;
  room.roundBets = [];
  room.tiebreakerActive = false;

  for (let i = 1; i <= room.players.length; i++) {
    const nextD = (room.dealerIdx + i) % room.players.length;
    const candidate = room.players[nextD];
    if (candidate && !candidate.isSpectator && candidate.lives > 0) {
      room.dealerIdx = nextD;
      break;
    }
  }

  const dealer = room.players[room.dealerIdx];

  active.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
    p.fedCardsTracker = {};
    p.lastDrawnSource = 'deal';

    if (dealer && dealer.id !== p.id) {
      p.fedCardsTracker[dealer.id] = [];
      p.hand.forEach(c => {
        if (c.rank === 'A' || c.value === 10) {
          p.fedCardsTracker[dealer.id].push(c);
        }
      });
    }
  });

  const firstDiscard = room.deck.pop();
  room.discardPile.push(firstDiscard);
  room.currentDiscardFeederId = dealer ? dealer.id : null;

  for (const p of active) {
    if (calculateScore(p.hand) === 31) {
      broadcastState(roomId, `⚡ ${p.name} was dealt 31!`);
      checkAndHandle31(room, p);
      return;
    }
  }

  room.currentTurnIdx = room.dealerIdx;
  advanceTurnIndex(room);

  broadcastState(roomId, `New round! Dealer: ${dealer?.name || 'Dealer'}. Place round side bets!`);
  broadcastRoomList();
  triggerBotTurnIfNeeded(roomId);
}

function broadcastState(roomId, message = '') {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActivePlayers(room);
  const currentTurnPlayer = room.players[room.currentTurnIdx];
  const minKnockScore = active.length === 2 ? 25 : 21;
  const roundHasPassed = room.turnsTakenInRound >= active.length;
  
  let totalGamePot = 0;
  if (room.gameStarted && room.currentMatchParticipants) {
    totalGamePot = room.currentMatchParticipants.reduce((sum, p) => sum + p.wager, 0);
  } else {
    totalGamePot = getActivePlayers(room).reduce((sum, p) => sum + (p.matchWager || 0), 0);
  }

  const totalRoundPot = (room.roundBets || []).reduce((sum, b) => sum + b.amount, 0);

  room.players.forEach(p => {
    if (p.isBot) return;

    if (room.gameStarted && !p.isSpectator && p.lives > 0 && p.hand && p.hand.length < 3 && room.deck && room.deck.length > 0) {
      while (p.hand.length < 3 && room.deck.length > 0) {
        p.hand.push(room.deck.pop());
      }
    }

    const isCurrent = currentTurnPlayer && currentTurnPlayer.id === p.id && !room.isResolvingRound && !p.isSpectator;
    const score = p.isSpectator ? 0 : calculateScore(p.hand);
    const canKnock = isCurrent && !room.knockerId && roundHasPassed && score >= minKnockScore && !room.drawnCard;

    const personalLedgerData = getPersonalLedger(room, p.name);

    io.to(p.id).emit('gameState', {
      myWager: p.matchWager || 0,
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        lives: pl.lives,
        cardCount: pl.hand ? pl.hand.length : 0,
        isDealer: room.players[room.dealerIdx]?.id === pl.id,
        isTurn: currentTurnPlayer?.id === pl.id,
        isBot: Boolean(pl.isBot),
        isSpectator: Boolean(pl.isSpectator),
        isReady: Boolean(pl.isReady),
        isInVoice: Boolean(pl.isInVoice),
        disconnected: Boolean(pl.disconnected),
        matchWager: pl.matchWager || 0
      })),
      hand: p.isSpectator ? [] : p.hand,
      score: score,
      minKnockScore: minKnockScore,
      roundHasPassed: roundHasPassed,
      topDiscard: room.discardPile[room.discardPile.length - 1] || null,
      isMyTurn: isCurrent,
      hasDrawn: Boolean(room.drawnCard),
      canKnock: canKnock,
      isSpectator: Boolean(p.isSpectator),
      manualSpectator: Boolean(p.manualSpectator),
      gameStarted: room.gameStarted,
      knocker: room.knockerId ? room.players.find(pl => pl.id === room.knockerId)?.name : null,
      isReady: Boolean(p.isReady),
      activePlayersCount: getNonSpectatorCount(room),
      botCount: room.players.filter(pl => pl.isBot).length,
      maxActivePlayers: MAX_ACTIVE_PLAYERS,
      totalPot: totalGamePot,
      roundPot: totalRoundPot,
      roundBets: (room.roundBets || []).map(b => ({
        bettor: b.bettorName,
        target: b.targetPlayerName,
        amt: b.amount
      })),
      personalLedger: personalLedgerData.balances,
      netOverallBalance: personalLedgerData.totalNet,
      message: message
    });
  });
}

function resolveShowdown(roomId) {
  const room = rooms[roomId];
  if (!room || room.isResolvingRound) return;
  room.isResolvingRound = true;

  const active = getActivePlayers(room);
  let minScore = 32;
  let maxScore = -1;
  const scores = {};

  active.forEach(p => {
    const sc = calculateScore(p.hand);
    scores[p.id] = sc;
    if (sc < minScore) minScore = sc;
    if (sc > maxScore) maxScore = sc;
  });

  const lowestPlayers = active.filter(p => scores[p.id] === minScore);
  const highestPlayers = active.filter(p => scores[p.id] === maxScore);
  const knocker = room.players.find(p => p.id === room.knockerId);
  const revealedHands = getRevealedHands(room);
  const sideBetReport = settleRoundBets(room, highestPlayers);

  if (knocker && lowestPlayers.some(p => p.id === knocker.id) && lowestPlayers.length === 1) {
    knocker.lives -= 1;
    const losersText = `${knocker.name} (Knocker lost alone)`;
    io.to(roomId).emit('bigAnnouncement', {
      title: '💀 ROUND OVER 💀',
      message: `LOSER: ${losersText}`,
      subtext: `${sideBetReport ? sideBetReport + ' | ' : ''}Lowest Score: ${minScore}`,
      hands: revealedHands,
      duration: 6500
    });
    broadcastState(roomId, `Showdown finished! Loser: ${losersText}`);
    setTimeout(() => startNewRound(roomId), 6500);
    return;
  }

  if (lowestPlayers.length > 1) {
    if (active.length === 2) {
      io.to(roomId).emit('bigAnnouncement', {
        title: '🤝 HEADS-UP TIE! 🤝',
        message: 'PUSH — RE-DEALING ROUND!',
        subtext: `${sideBetReport ? sideBetReport + ' | ' : ''}Both players tied at ${minScore} points`,
        hands: revealedHands,
        duration: 6500
      });
      broadcastState(roomId, `Heads-up tie at ${minScore}! Re-dealing with no lives lost.`);
      setTimeout(() => startNewRound(roomId), 4500);
      return;
    }

    startInteractiveTiebreaker(room, lowestPlayers, sideBetReport);
    return;
  }

  const singleLoser = lowestPlayers[0];
  singleLoser.lives -= 1;

  io.to(roomId).emit('bigAnnouncement', {
    title: '💀 ROUND OVER 💀',
    message: `LOSER: ${singleLoser.name}`,
    subtext: `${sideBetReport ? sideBetReport + ' | ' : ''}Lowest Score: ${minScore}`,
    hands: revealedHands,
    duration: 6500
  });

  broadcastState(roomId, `Showdown finished! Loser: ${singleLoser.name}`);
  setTimeout(() => startNewRound(roomId), 6500);
}

function triggerBotTurnIfNeeded(roomId) {
  const room = rooms[roomId];
  if (!room || !room.gameStarted || room.isResolvingRound) return;

  const current = room.players[room.currentTurnIdx];
  if (!current || !current.isBot || current.lives <= 0 || current.isSpectator) return;

  while (current.hand && current.hand.length < 3 && room.deck && room.deck.length > 0) {
    current.hand.push(room.deck.pop());
  }

  setTimeout(() => {
    if (!rooms[roomId] || room.isResolvingRound) return;

    const activeCount = getActivePlayers(room).length;
    const minKnockScore = activeCount === 2 ? 25 : 21;
    const roundHasPassed = room.turnsTakenInRound >= activeCount;
    const score = calculateScore(current.hand);

    const topDiscard = room.discardPile[room.discardPile.length - 1];
    const topIsDangerous = topDiscard && (topDiscard.rank === 'A' || topDiscard.value === 10);

    // Bot Knock Check (Bot avoids knocking if high-value card is left unless its score is very strong)
    if (!room.knockerId && roundHasPassed && score >= Math.max(minKnockScore, 26) && (!topIsDangerous || score >= 29)) {
      room.knockerId = current.id;
      room.turnsLeftAfterKnock = activeCount - 1;
      room.currentDiscardFeederId = current.id;

      io.to(roomId).emit('bigAnnouncement', {
        title: '🔔 KNOCK! 🔔',
        message: `${current.name.toUpperCase()} KNOCKED!`,
        subtext: 'Everyone gets 1 final turn!',
        sound: 'knock',
        duration: 3500
      });

      advanceTurnIndex(room);
      broadcastState(roomId, `🔔 Bot ${current.name} KNOCKED! Turn passes.`);
      triggerBotTurnIfNeeded(roomId);
      return;
    }

    let takeDiscard = false;
    if (topDiscard) {
      for (let i = 0; i < current.hand.length; i++) {
        const simHand = current.hand.slice(0, i).concat(current.hand.slice(i + 1), [topDiscard]);
        if (calculateScore(simHand) > score) {
          takeDiscard = true;
          break;
        }
      }
    }

    let drawn;
    if (takeDiscard) {
      drawn = room.discardPile.pop();
      current.lastDrawnSource = 'discard';

      const feederId = room.currentDiscardFeederId || getPrevActivePlayer(room, room.currentTurnIdx)?.id;
      if (feederId) {
        if (!current.fedCardsTracker) current.fedCardsTracker = {};
        if (!current.fedCardsTracker[feederId]) current.fedCardsTracker[feederId] = [];
        current.fedCardsTracker[feederId].push(drawn);
      }

      io.to(roomId).emit('bannerAnnouncement', {
        text: `👀 ${current.name} took ${drawn.rank}${drawn.suit} from the DISCARD pile!`,
        duration: 3200
      });
    } else {
      if (room.deck.length === 0) {
        const top = room.discardPile.pop();
        room.deck = room.deck.concat(room.discardPile.sort(() => Math.random() - 0.5));
        room.discardPile = [top];
      }
      drawn = room.deck.pop();
      current.lastDrawnSource = 'deck';
    }
    current.hand.push(drawn);

    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < current.hand.length; i++) {
      const remaining = current.hand.slice(0, i).concat(current.hand.slice(i + 1));
      const s = calculateScore(remaining);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    const [discarded] = current.hand.splice(bestIdx, 1);
    room.discardPile.push(discarded);
    room.currentDiscardFeederId = current.id;
    room.turnsTakenInRound += 1;

    if (checkAndHandle31(room, current)) return;

    if (room.knockerId) {
      room.turnsLeftAfterKnock -= 1;
      if (room.turnsLeftAfterKnock <= 0) {
        resolveShowdown(roomId);
        return;
      }
    }

    advanceTurnIndex(room);
    broadcastState(roomId, `${current.name} discarded ${discarded.rank}${discarded.suit}.`);
    triggerBotTurnIfNeeded(roomId);
  }, 1200);
}

function handlePlayerDisconnect(socketId) {
  for (const [roomId, room] of Object.entries(rooms)) {
    const player = room.players.find(p => p.id === socketId);
    if (player && !player.isBot) {
      player.disconnected = true;
      io.to(roomId).emit('voiceUserLeft', { socketId: socketId });
      broadcastState(roomId, `${player.name} disconnected (reconnecting...).`);

      const key = `${roomId}:::${player.name}`;
      if (disconnectTimeouts[key]) {
        clearTimeout(disconnectTimeouts[key]);
      }

      disconnectTimeouts[key] = setTimeout(() => {
        delete disconnectTimeouts[key];
        finalizePlayerExit(roomId, player.name);
      }, 45000);
      break;
    }
  }
}

function finalizePlayerExit(roomId, playerName) {
  const room = rooms[roomId];
  if (!room) return;
  const idx = room.players.findIndex(p => p.name === playerName);
  if (idx === -1) return;
  const leaving = room.players[idx];
  if (!leaving.disconnected) return;

  if (!room.gameStarted || leaving.isSpectator) {
    room.players.splice(idx, 1);
  } else {
    leaving.lives = 0;
    if (room.currentTurnIdx === idx) {
      advanceTurnIndex(room);
      triggerBotTurnIfNeeded(roomId);
    }
  }

  if (getActivePlayers(room).length === 0 && room.players.length === 0) {
    delete rooms[roomId];
  } else {
    broadcastState(roomId, `${leaving.name} left the match.`);
    if (room.gameStarted && getActivePlayers(room).length <= 1) {
      startNewRound(roomId);
    }
  }
  broadcastRoomList();
}

io.on('connection', (socket) => {
  socket.emit('roomListUpdate', Object.entries(rooms).map(([id, r]) => {
    let totalPot = 0;
    if (r.gameStarted && r.currentMatchParticipants) {
      totalPot = r.currentMatchParticipants.reduce((sum, p) => sum + p.wager, 0);
    } else {
      totalPot = getActivePlayers(r).reduce((sum, p) => sum + (p.matchWager || 0), 0);
    }
    return {
      roomId: id,
      gameStarted: r.gameStarted,
      activeCount: r.players.filter(p => !p.isSpectator).length,
      spectatorCount: r.players.filter(p => p.isSpectator).length,
      totalPot: totalPot
    };
  }));

  socket.on('requestStateSync', (roomId) => {
    if (roomId && rooms[roomId]) {
      broadcastState(roomId);
    }
  });

  socket.on('joinRoom', ({ roomId, playerName }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        players: [],
        deck: [],
        discardPile: [],
        dealerIdx: 0,
        currentTurnIdx: 0,
        knockerId: null,
        turnsLeftAfterKnock: null,
        gameStarted: false,
        drawnCard: null,
        isResolvingRound: false,
        turnsTakenInRound: 0,
        currentDiscardFeederId: null,
        currentMatchParticipants: [],
        roundBets: [],
        debts: {}
      };
    }
    const room = rooms[roomId];

    const existingPlayer = room.players.find(p => p.name === playerName);
    if (existingPlayer) {
      const key = `${roomId}:::${existingPlayer.name}`;
      if (disconnectTimeouts[key]) {
        clearTimeout(disconnectTimeouts[key]);
        delete disconnectTimeouts[key];
      }
      existingPlayer.id = socket.id;
      existingPlayer.disconnected = false;
      broadcastState(roomId, `${playerName} reconnected.`);
      broadcastRoomList();
      return;
    }

    const currentActiveCount = getNonSpectatorCount(room);
    const roomIsFull = currentActiveCount >= MAX_ACTIVE_PLAYERS;
    const isSpectator = Boolean(room.gameStarted || roomIsFull);

    room.players.push({
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      lives: isSpectator ? 0 : 2,
      hand: [],
      fedCardsTracker: {},
      lastDrawnSource: null,
      isBot: false,
      isSpectator: isSpectator,
      manualSpectator: false,
      isReady: false,
      isInVoice: false,
      disconnected: false,
      matchWager: 0
    });

    let joinMsg = `${playerName} joined the room.`;
    if (roomIsFull && !room.gameStarted) {
      joinMsg = `👁️ Room active limit (6) reached. ${playerName} is spectating.`;
    } else if (room.gameStarted) {
      joinMsg = `👁️ ${playerName} joined as a spectator.`;
    }

    broadcastState(roomId, joinMsg);
    broadcastRoomList();
  });

  socket.on('toggleSpectate', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (!player.manualSpectator) {
      player.manualSpectator = true;
      player.isSpectator = true;
      player.lives = 0;
      player.isReady = false;
      broadcastState(roomId, `👁️ ${player.name} switched to Spectator Mode.`);
    } else {
      if (getNonSpectatorCount(room) >= MAX_ACTIVE_PLAYERS) {
        return socket.emit('errorMsg', 'Table is full (6 active players max).');
      }
      player.manualSpectator = false;
      player.isSpectator = false;
      player.lives = 2;
      player.isReady = false;
      broadcastState(roomId, `🃏 ${player.name} rejoined as an active player.`);
    }
    broadcastRoomList();
  });

  socket.on('setWager', ({ roomId, wager }) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.isSpectator) return;

    const parsed = Math.max(0, parseInt(wager) || 0);
    player.matchWager = parsed;
    broadcastState(roomId, `💰 ${player.name} set their match wager to $${parsed}.`);
    broadcastRoomList();
  });

  socket.on('placeRoundBet', ({ roomId, targetPlayerName, amount }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted || room.isResolvingRound) {
      return socket.emit('errorMsg', 'Round betting is only open during an active round.');
    }
    if (room.knockerId) {
      return socket.emit('errorMsg', 'Bets locked! Someone has already knocked.');
    }

    const bettor = room.players.find(p => p.id === socket.id);
    if (!bettor) return;

    const parsedAmt = Math.max(1, parseInt(amount) || 1);
    const targetPlayer = room.players.find(p => p.name === targetPlayerName && !p.isSpectator && p.lives > 0);
    if (!targetPlayer) {
      return socket.emit('errorMsg', 'Invalid target player for side bet.');
    }

    if (!room.roundBets) room.roundBets = [];

    const existingBetIdx = room.roundBets.findIndex(b => b.bettorId === socket.id);
    if (existingBetIdx !== -1) {
      room.roundBets[existingBetIdx] = {
        bettorId: socket.id,
        bettorName: bettor.name,
        targetPlayerName: targetPlayer.name,
        amount: parsedAmt
      };
    } else {
      room.roundBets.push({
        bettorId: socket.id,
        bettorName: bettor.name,
        targetPlayerName: targetPlayer.name,
        amount: parsedAmt
      });
    }

    broadcastState(roomId, `🎲 ${bettor.name} bet $${parsedAmt} on ${targetPlayer.name} to win this round!`);
  });

  socket.on('pickTiebreakerCard', ({ roomId, cardIndex }) => {
    const room = rooms[roomId];
    if (!room || !room.tiebreakerActive || !room.tiedPlayerIds.includes(socket.id)) return;
    if (room.tiebreakerPicks[socket.id]) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const safeIdx = Math.min(Math.max(0, cardIndex), room.tiebreakerDeck.length - 1);
    const card = room.tiebreakerDeck.splice(safeIdx, 1)[0];
    room.tiebreakerPicks[socket.id] = { player: player, card: card };

    io.to(roomId).emit('tiebreakerCardPicked', {
      playerId: socket.id,
      playerName: player.name,
      remainingCount: room.tiebreakerDeck.length
    });

    checkTiebreakerComplete(room);
  });

  socket.on('joinVoice', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.isInVoice = true;

    const otherVoiceUsers = room.players
      .filter(p => p.isInVoice && p.id !== socket.id)
      .map(p => p.id);

    socket.emit('currentVoiceUsers', otherVoiceUsers);
    socket.to(roomId).emit('voiceUserJoined', { socketId: socket.id });
    broadcastState(roomId);
  });

  socket.on('leaveVoice', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.isInVoice = false;

    socket.to(roomId).emit('voiceUserLeft', { socketId: socket.id });
    broadcastState(roomId);
  });

  socket.on('voiceSignal', ({ target, signal }) => {
    io.to(target).emit('voiceSignal', {
      sender: socket.id,
      signal: signal
    });
  });

  socket.on('toggleReady', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.isSpectator) return;

    player.isReady = !player.isReady;
    broadcastState(roomId, `${player.name} is ${player.isReady ? 'READY' : 'NOT READY'}.`);

    if (!room.gameStarted && checkAllPlayersReady(room)) {
      room.gameStarted = true;
      room.currentMatchParticipants = getActivePlayers(room).map(p => ({
        id: p.id,
        name: p.name,
        wager: p.matchWager || 0
      }));
      startNewRound(roomId);
    }
    broadcastRoomList();
  });

  socket.on('leaveRoom', (roomId) => {
    socket.leave(roomId);
    finalizePlayerExit(roomId, room?.players.find(p => p.id === socket.id)?.name);
  });

  socket.on('sendChatMessage', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room || !message || !message.trim()) return;

    const sender = room.players.find(p => p.id === socket.id);
    const senderName = sender ? sender.name : 'Unknown';
    const isSpectator = sender ? sender.isSpectator : false;

    io.to(roomId).emit('newChatMessage', {
      sender: senderName,
      text: message.trim().slice(0, 150),
      isSpectator: isSpectator,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('addBot', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;
    if (getNonSpectatorCount(room) >= MAX_ACTIVE_PLAYERS) {
      return socket.emit('errorMsg', 'Max 6 active players allowed in the game.');
    }

    const botCount = room.players.filter(p => p.isBot).length + 1;
    room.players.push({
      id: `bot_${Date.now()}_${Math.random()}`,
      name: `Bot ${botCount}`,
      lives: 2,
      hand: [],
      fedCardsTracker: {},
      lastDrawnSource: null,
      isBot: true,
      isSpectator: false,
      manualSpectator: false,
      isReady: true,
      isInVoice: false,
      disconnected: false,
      matchWager: 5
    });

    broadcastState(roomId, `Bot ${botCount} joined.`);
    if (checkAllPlayersReady(room)) {
      room.gameStarted = true;
      room.currentMatchParticipants = getActivePlayers(room).map(p => ({
        id: p.id,
        name: p.name,
        wager: p.matchWager || 0
      }));
      startNewRound(roomId);
    }
    broadcastRoomList();
  });

  socket.on('removeBot', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;

    const lastBotIdx = room.players.map(p => p.isBot).lastIndexOf(true);
    if (lastBotIdx === -1) {
      return socket.emit('errorMsg', 'No bots in room to remove.');
    }

    const [removedBot] = room.players.splice(lastBotIdx, 1);
    broadcastState(roomId, `${removedBot.name} was removed from the lobby.`);

    if (checkAllPlayersReady(room)) {
      room.gameStarted = true;
      room.currentMatchParticipants = getActivePlayers(room).map(p => ({
        id: p.id,
        name: p.name,
        wager: p.matchWager || 0
      }));
      startNewRound(roomId);
    }
    broadcastRoomList();
  });

  socket.on('knock', (roomId) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.knockerId || room.isResolvingRound || player.isSpectator) return;

    const activeCount = getActivePlayers(room).length;
    const minKnockScore = activeCount === 2 ? 25 : 21;
    const roundHasPassed = room.turnsTakenInRound >= activeCount;
    const score = calculateScore(player.hand);

    if (!roundHasPassed) {
      return socket.emit('errorMsg', 'Must wait 1 full round before knocking!');
    }

    if (score >= minKnockScore && !room.drawnCard) {
      room.knockerId = player.id;
      room.turnsLeftAfterKnock = activeCount - 1;
      room.currentDiscardFeederId = player.id;

      io.to(roomId).emit('bigAnnouncement', {
        title: '🔔 KNOCK! 🔔',
        message: `${player.name.toUpperCase()} KNOCKED!`,
        subtext: 'Everyone gets 1 final turn!',
        sound: 'knock',
        duration: 3500
      });

      advanceTurnIndex(room);
      broadcastState(roomId, `🔔 ${player.name} has KNOCKED! Final turn for all other players.`);
      triggerBotTurnIfNeeded(roomId);
    }
  });

  socket.on('drawCard', ({ roomId, source }) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.drawnCard || room.isResolvingRound || player.isSpectator) return;

    if (player.hand.length !== 3) {
      while (player.hand.length < 3 && room.deck.length > 0) {
        player.hand.push(room.deck.pop());
      }
      broadcastState(roomId, `Re-synchronized hand.`);
      return;
    }

    let drawn;
    if (source === 'discard') {
      if (room.discardPile.length === 0) return;
      drawn = room.discardPile.pop();
      player.lastDrawnSource = 'discard';

      const feederId = room.currentDiscardFeederId || getPrevActivePlayer(room, room.currentTurnIdx)?.id;
      if (feederId) {
        if (!player.fedCardsTracker) player.fedCardsTracker = {};
        if (!player.fedCardsTracker[feederId]) player.fedCardsTracker[feederId] = [];
        player.fedCardsTracker[feederId].push(drawn);
      }
      
      io.to(roomId).emit('bannerAnnouncement', {
        text: `👀 ${player.name} picked up ${drawn.rank}${drawn.suit} from the DISCARD pile!`,
        duration: 3200
      });
      broadcastState(roomId, `⚠️ ${player.name} picked up ${drawn.rank}${drawn.suit} from the discard pile!`);
    } else {
      if (room.deck.length === 0) {
        const top = room.discardPile.pop();
        room.deck = room.deck.concat(room.discardPile.sort(() => Math.random() - 0.5));
        room.discardPile = [top];
      }
      drawn = room.deck.pop();
      player.lastDrawnSource = 'deck';
      broadcastState(roomId, `${player.name} drew a card from the deck.`);
    }

    room.drawnCard = drawn;
    player.hand.push(drawn);
    broadcastState(roomId);
  });

  socket.on('discardCard', ({ roomId, cardIndex }) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || !room.drawnCard || room.isResolvingRound || player.isSpectator) return;

    if (player.hand.length !== 4) {
      room.drawnCard = null;
      while (player.hand.length < 3 && room.deck.length > 0) {
        player.hand.push(room.deck.pop());
      }
      broadcastState(roomId, `Hand corrected.`);
      return;
    }

    if (cardIndex < 0 || cardIndex >= player.hand.length) return;

    const [discarded] = player.hand.splice(cardIndex, 1);
    room.discardPile.push(discarded);
    room.currentDiscardFeederId = player.id;
    room.drawnCard = null;
    room.turnsTakenInRound += 1;

    if (checkAndHandle31(room, player)) return;

    if (room.knockerId) {
      room.turnsLeftAfterKnock -= 1;
      if (room.turnsLeftAfterKnock <= 0) {
        resolveShowdown(roomId);
        return;
      }
    }

    advanceTurnIndex(room);
    broadcastState(roomId, `${player.name} discarded ${discarded.rank}${discarded.suit}.`);
    triggerBotTurnIfNeeded(roomId);
  });

  socket.on('disconnect', () => {
    handlePlayerDisconnect(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server online on port ${PORT}`);
});
