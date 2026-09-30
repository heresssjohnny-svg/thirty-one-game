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

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]:', reason);
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
let playerJoinCounter = 0;

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
  room.players.forEach(p => {
    if (!p.isSpectator && p.lives <= 0) {
      p.isSpectator = true;
      p.hand = [];
    }
  });
  return room.players.filter(p => !p.isSpectator && p.lives > 0);
}

function getNonSpectatorCount(room) {
  return room.players.filter(p => !p.isSpectator).length;
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnExpiresAt = null;
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room || !room.gameStarted || room.isResolvingRound) return;

  clearTurnTimer(room);

  const durationMs = 45000; // 45 seconds
  room.turnExpiresAt = Date.now() + durationMs;

  room.turnTimer = setTimeout(() => {
    handleTurnTimeout(roomId);
  }, durationMs);

  broadcastState(roomId);
}

function handleTurnTimeout(roomId) {
  const room = rooms[roomId];
  if (!room || !room.gameStarted || room.isResolvingRound) return;

  const current = room.players[room.currentTurnIdx];
  if (!current || current.isSpectator || current.lives <= 0) return;

  io.to(roomId).emit('bannerAnnouncement', {
    text: `⏱️️ Time's up for ${current.name}! AI taking turn...`,
    duration: 3500
  });

  while (current.hand && current.hand.length < 3 && room.deck && room.deck.length > 0) {
    current.hand.push(room.deck.pop());
  }

  if (!room.drawnCard) {
    if (room.deck.length === 0) {
      const top = room.discardPile.pop();
      room.deck = room.discardPile.concat(room.discardPile.sort(() => Math.random() - 0.5));
      room.discardPile = [top];
    }
    const drawn = room.deck.pop();
    current.lastDrawnSource = 'deck';
    current.hand.push(drawn);
    room.drawnCard = drawn;
  }

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
  room.drawnCard = null;
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
  broadcastState(roomId, `⏱️ ${current.name}'s turn timed out. AI discarded ${discarded.rank}${discarded.suit}.`);
  startTurnTimer(roomId);
  triggerBotTurnIfNeeded(roomId);
}

function advanceTurnIndex(room) {
  clearTurnTimer(room);
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
      startTurnTimer(room.id);
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
  return room.players.filter(p => !p.isSpectator).map(p => ({
    name: p.name,
    score: calculateScore(p.hand),
    hand: p.hand,
    isKnocker: room.knockerId === p.id
  }));
}

function recordDebt(room, debtorName, creditorName, amount, reason = 'match') {
  if (debtorName === creditorName || amount <= 0) return;
  if (!room.debts) room.debts = {};
  if (!room.debts[debtorName]) room.debts[debtorName] = {};
  if (!room.debtBreakdowns) room.debtBreakdowns = {};

  const key = `${debtorName}:::${creditorName}`;
  if (!room.debtBreakdowns[key]) {
    room.debtBreakdowns[key] = { match: 0, sideBets: 0 };
  }

  room.debts[debtorName][creditorName] = (room.debts[debtorName][creditorName] || 0) + amount;
  if (reason === 'sideBet') {
    room.debtBreakdowns[key].sideBets += amount;
  } else {
    room.debtBreakdowns[key].match += amount;
  }
}

function getNetPairBalance(room, p1Name, p2Name) {
  const p2OwesP1Match = (room.debts && room.debts[p2Name] && room.debts[p2Name][p1Name]) || 0;
  const p1OwesP2Match = (room.debts && room.debts[p1Name] && room.debts[p1Name][p2Name]) || 0;

  const key1 = `${p2Name}:::${p1Name}`;
  const key2 = `${p1Name}:::${p2Name}`;

  const p2SideBets = (room.debtBreakdowns && room.debtBreakdowns[key1] && room.debtBreakdowns[key1].sideBets) || 0;
  const p1SideBets = (room.debtBreakdowns && room.debtBreakdowns[key2] && room.debtBreakdowns[key2].sideBets) || 0;

  const p2MatchOnly = Math.max(0, p2OwesP1Match - p2SideBets);
  const p1MatchOnly = Math.max(0, p1OwesP2Match - p1SideBets);

  const netMatch = p2MatchOnly - p1MatchOnly;
  const netSideBet = p2SideBets - p1SideBets;

  return {
    net: netMatch + netSideBet,
    sideBetNet: netSideBet
  };
}

function getPersonalLedger(room, playerName) {
  const ledger = [];
  let totalNet = 0;
  let totalSideBetNet = 0;

  const allNames = new Set(room.knownMembers || []);
  room.players.forEach(p => allNames.add(p.name));

  if (room.debts) {
    Object.keys(room.debts).forEach(name => {
      allNames.add(name);
      Object.keys(room.debts[name] || {}).forEach(target => allNames.add(target));
    });
  }

  const activeNames = new Set(room.players.map(p => p.name));

  allNames.forEach(otherName => {
    if (otherName === playerName) return;
    const balanceInfo = getNetPairBalance(room, playerName, otherName);
    totalNet += balanceInfo.net;
    totalSideBetNet += balanceInfo.sideBetNet;
    ledger.push({
      player: otherName,
      netBalance: balanceInfo.net,
      sideBetBalance: balanceInfo.sideBetNet,
      hasLeft: !activeNames.has(otherName)
    });
  });

  ledger.sort((a, b) => b.netBalance - a.netBalance);

  return {
    balances: ledger,
    totalNet: totalNet,
    totalSideBetNet: totalSideBetNet
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
        recordDebt(room, loserData.name, winnerData.name, amountToCollect, 'match');
        totalCollected += amountToCollect;
      }
    }
  });

  return totalCollected;
}

function settlePeerRoundBets(room, scores) {
  if (!room.peerSideBets || room.peerSideBets.length === 0) return '';
  const resultsSummary = [];

  room.peerSideBets.forEach(bet => {
    if (!bet.accepted || bet.type !== 'round') return;

    let bTargetId = bet.bettorTargetId;
    let oTargetId = bet.opponentTargetId;

    if (!bTargetId || scores[bTargetId] === undefined) {
      const matchP = room.players.find(p => p.name === bet.targetPlayerName);
      if (matchP) bTargetId = matchP.id;
    }
    if (!oTargetId || scores[oTargetId] === undefined) {
      const matchP = room.players.find(p => p.name === bet.opponentTargetName);
      if (matchP) oTargetId = matchP.id;
    }

    const bettorTargetScore = (bTargetId && scores[bTargetId] !== undefined) ? scores[bTargetId] : -1;
    const opponentTargetScore = (oTargetId && scores[oTargetId] !== undefined) ? scores[oTargetId] : -1;

    if (bettorTargetScore > opponentTargetScore) {
      recordDebt(room, bet.opponentName, bet.bettorName, bet.amount, 'sideBet');
      resultsSummary.push(`${bet.bettorName}'s pick (${bet.targetPlayerName}: ${bettorTargetScore} pts) beat ${bet.opponentName}'s pick (${bet.opponentTargetName}: ${opponentTargetScore} pts) -> +$${bet.amount}`);
    } else if (opponentTargetScore > bettorTargetScore) {
      recordDebt(room, bet.bettorName, bet.opponentName, bet.amount, 'sideBet');
      resultsSummary.push(`${bet.opponentName}'s pick (${bet.opponentTargetName}: ${opponentTargetScore} pts) beat ${bet.bettorName}'s pick (${bet.targetPlayerName}: ${bettorTargetScore} pts) -> +$${bet.amount}`);
    } else {
      resultsSummary.push(`${bet.bettorName} & ${bet.opponentName} picks tied at ${bettorTargetScore} pts (push)`);
    }
  });

  room.peerSideBets = room.peerSideBets.filter(b => b.type !== 'round');
  return resultsSummary.length > 0 ? `Round Side Bets: ${resultsSummary.join(' | ')}` : '';
}

function settleFirstLoserBetsThisHand(room, newlyEliminatedNames) {
  if (!room.peerSideBets || room.peerSideBets.length === 0 || !newlyEliminatedNames || newlyEliminatedNames.length === 0) return '';
  const resultsSummary = [];

  room.peerSideBets.forEach(bet => {
    if (!bet.accepted || bet.type !== 'firstLoser') return;

    if (newlyEliminatedNames.includes(bet.targetPlayerName)) {
      recordDebt(room, bet.opponentName, bet.bettorName, bet.amount, 'sideBet');
      resultsSummary.push(`${bet.bettorName} won first-loser bet vs ${bet.opponentName} on ${bet.targetPlayerName} (+$${bet.amount})`);
    }
  });

  room.peerSideBets = room.peerSideBets.filter(b => {
    if (b.type !== 'firstLoser' || !b.accepted) return true;
    return !newlyEliminatedNames.includes(b.targetPlayerName);
  });

  return resultsSummary.length > 0 ? `First-Loser Bets Settled: ${resultsSummary.join(' | ')}` : '';
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

function broadcastSpectatorPeeks(room) {
  if (!room.spectatorPeeks) return;

  for (const [spectatorId, targetPlayerId] of Object.entries(room.spectatorPeeks)) {
    const targetPlayer = room.players.find(p => p.id === targetPlayerId);
    if (targetPlayer && targetPlayer.hand) {
      io.to(spectatorId).emit('spectatorHandUpdate', {
        targetPlayerName: targetPlayer.name,
        targetPlayerId: targetPlayer.id,
        hand: targetPlayer.hand,
        score: calculateScore(targetPlayer.hand)
      });
    } else {
      delete room.spectatorPeeks[spectatorId];
      io.to(spectatorId).emit('spectatorHandRevoked');
    }
  }
}

function startDealerCut(room) {
  room.dealerCutActive = true;
  room.dealerCutPicks = {};
  
  const eligible = getActivePlayers(room);
  room.dealerCutPlayerIds = eligible.map(p => p.id);

  let cutDeck = createDeck();
  room.dealerCutDeck = cutDeck;

  io.to(room.id).emit('startDealerSelectionCut', {
    deckCount: Math.min(cutDeck.length, 30),
    players: eligible.map(p => ({ id: p.id, name: p.name }))
  });

  eligible.forEach(p => {
    if (p.isBot) {
      setTimeout(() => {
        if (!room.dealerCutActive || room.dealerCutPicks[p.id]) return;
        const chosenCardIdx = Math.floor(Math.random() * room.dealerCutDeck.length);
        const card = room.dealerCutDeck.splice(chosenCardIdx, 1)[0];
        room.dealerCutPicks[p.id] = { player: p, card: card };

        io.to(room.id).emit('dealerCutCardPicked', {
          playerId: p.id,
          playerName: p.name,
          remainingCount: room.dealerCutDeck.length
        });

        checkDealerCutComplete(room);
      }, 1000 + Math.random() * 800);
    }
  });
}

function checkDealerCutComplete(room) {
  if (!room.dealerCutActive) return;
  const eligible = getActivePlayers(room);
  room.dealerCutPlayerIds = eligible.map(p => p.id);

  for (const pickId of Object.keys(room.dealerCutPicks)) {
    if (!eligible.some(p => p.id === pickId)) {
      delete room.dealerCutPicks[pickId];
    }
  }

  const requiredCount = room.dealerCutPlayerIds.length;
  const pickedCount = Object.keys(room.dealerCutPicks).length;
  if (pickedCount < requiredCount) return;

  room.dealerCutActive = false;
  const picks = Object.values(room.dealerCutPicks);

  let minCardVal = 99;
  let lowestPickers = [];
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
      lowestPickers = [item];
    } else if (rankVal === minCardVal) {
      lowestPickers.push(item);
    }
  });

  io.to(room.id).emit('dealerCutResultsReveal', {
    results: revealData
  });

  if (lowestPickers.length > 1) {
    setTimeout(() => {
      if (!room) return;
      io.to(room.id).emit('bannerAnnouncement', {
        text: `Tie for lowest dealer cut card! Re-cutting...`,
        duration: 2500
      });
      room.dealerCutActive = true;
      room.dealerCutPicks = {};
      room.dealerCutPlayerIds = lowestPickers.map(l => l.player.id);
      room.dealerCutDeck = createDeck();

      io.to(room.id).emit('startDealerSelectionCut', {
        deckCount: Math.min(room.dealerCutDeck.length, 30),
        players: lowestPickers.map(l => ({ id: l.player.id, name: l.player.name }))
      });

      lowestPickers.forEach(l => {
        if (l.player.isBot) {
          setTimeout(() => {
            if (!room.dealerCutActive || room.dealerCutPicks[l.player.id]) return;
            const chosenCardIdx = Math.floor(Math.random() * room.dealerCutDeck.length);
            const card = room.dealerCutDeck.splice(chosenCardIdx, 1)[0];
            room.dealerCutPicks[l.player.id] = { player: l.player, card: card };
            checkDealerCutComplete(room);
          }, 1000 + Math.random() * 800);
        }
      });
    }, 3200);
    return;
  }

  const chosenDealer = lowestPickers[0].player;
  const dealerIdx = room.players.findIndex(p => p.id === chosenDealer.id);
  room.dealerIdx = dealerIdx >= 0 ? dealerIdx : 0;

  setTimeout(() => {
    io.to(room.id).emit('bigAnnouncement', {
      title: '👑 DEALER SELECTED! 👑',
      message: `${chosenDealer.name.toUpperCase()} IS DEALER!`,
      subtext: `Drew lowest card (${lowestPickers[0].card.rank}${lowestPickers[0].card.suit})`,
      duration: 3500
    });
    setTimeout(() => startNewRound(room.id), 3800);
  }, 3200);
}

function startInteractiveTiebreaker(room, tiedPlayers) {
  room.tiebreakerActive = true;
  room.tiebreakerPicks = {};
  room.tiedPlayerIds = tiedPlayers.map(p => p.id);

  let eligibleDeck = [...(room.deck || [])];
  if (eligibleDeck.length < 15) {
    const top = room.discardPile.length > 0 ? room.discardPile.pop() : null;
    eligibleDeck = eligibleDeck.concat(room.discardPile.sort(() => Math.random() - 0.5));
    if (top) room.discardPile = [top];
  }
  if (eligibleDeck.length < 5) {
    eligibleDeck = createDeck();
  }
  room.tiebreakerDeck = eligibleDeck.sort(() => Math.random() - 0.5);

  io.to(room.id).emit('startTiebreakerCut', {
    deckCount: room.tiebreakerDeck.length,
    tiedPlayers: tiedPlayers.map(p => ({ id: p.id, name: p.name }))
  });

  tiedPlayers.forEach(p => {
    if (p.isBot) {
      setTimeout(() => {
        if (!room.tiebreakerActive || (room.tiebreakerPicks && room.tiebreakerPicks[p.id])) return;
        if (!room.tiebreakerDeck || room.tiebreakerDeck.length === 0) return;
        const chosenCardIdx = Math.floor(Math.random() * room.tiebreakerDeck.length);
        const card = room.tiebreakerDeck.splice(chosenCardIdx, 1)[0];
        if (!room.tiebreakerPicks) room.tiebreakerPicks = {};
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
  if (!room.tiebreakerActive) return;
  const activeEligible = getActivePlayers(room);

  for (const pickId of Object.keys(room.tiebreakerPicks || {})) {
    if (!activeEligible.some(p => p.id === pickId)) {
      delete room.tiebreakerPicks[pickId];
    }
  }

  const requiredCount = room.tiebreakerPicks ? Object.keys(room.tiebreakerPicks).length : 0;
  if (requiredCount < room.tiedPlayerIds.filter(id => activeEligible.some(p => p.id === id)).length) return;

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
      if (!room) return;
      io.to(room.id).emit('bannerAnnouncement', {
        text: `Tie for lowest cut! Re-drawing lowest players...`,
        duration: 2500
      });
      startInteractiveTiebreaker(room, cutLosers.map(l => l.player));
    }, 2800);
    return;
  }

  const ultimateLoser = cutLosers[0];
  ultimateLoser.player.lives -= 1;
  let newlyEliminated = [];
  if (ultimateLoser.player.lives <= 0) {
    newlyEliminated.push(ultimateLoser.player.name);
  }
  const firstLoserReport = settleFirstLoserBetsThisHand(room, newlyEliminated);

  setTimeout(() => {
    io.to(room.id).emit('bigAnnouncement', {
      title: '⚡ TIEBREAKER FINISHED! ⚡',
      message: `LOSER: ${ultimateLoser.player.name.toUpperCase()} (${ultimateLoser.card.rank}${ultimateLoser.card.suit})`,
      subtext: `${firstLoserReport ? firstLoserReport + ' | ' : ''}Picked lowest card from the deck!`,
      hands: getRevealedHands(room),
      duration: 7500
    });

    broadcastState(room.id, `Tiebreaker Cut: ${ultimateLoser.player.name} picked the lowest card (${ultimateLoser.card.rank}${ultimateLoser.card.suit}) and lost a life!`);
    setTimeout(() => startNewRound(room.id), 7500);
  }, 3200);
}

function checkAndHandle31(room, player) {
  if (calculateScore(player.hand) !== 31) return false;
  if (room.isResolvingRound) return true;
  room.isResolvingRound = true;

  let penalizedGiver = null;
  const revealedHands = getRevealedHands(room);

  const scores = {};
  getActivePlayers(room).forEach(p => {
    scores[p.id] = calculateScore(p.hand);
  });
  scores[player.id] = 31;
  const roundBetReport = settlePeerRoundBets(room, scores);

  if (player.lastDrawnSource === 'discard' && player.fedCardsTracker && player.discardPickedCards) {
    for (const [giverId, cards] of Object.entries(player.fedCardsTracker)) {
      const cardsInHandFromGiver = cards.filter(c => 
        player.hand.some(hCard => hCard.rank === c.rank && hCard.suit === c.suit)
      );

      const pickedFromDiscard = cardsInHandFromGiver.every(c => 
        player.discardPickedCards.some(dCard => dCard.rank === c.rank && dCard.suit === c.suit)
      );

      const hasAce = cardsInHandFromGiver.some(c => c.rank === 'A');
      const hasFaceCard = cardsInHandFromGiver.some(c => c.value === 10);

      if (hasAce && hasFaceCard && pickedFromDiscard) {
        penalizedGiver = room.players.find(p => p.id === giverId && p.lives > 0);
        if (penalizedGiver) break;
      }
    }
  }

  let newlyEliminated = [];
  if (penalizedGiver) {
    penalizedGiver.lives = Math.max(0, penalizedGiver.lives - 2);
    if (penalizedGiver.lives <= 0) {
      newlyEliminated.push(penalizedGiver.name);
    }
    const firstLoserReport = settleFirstLoserBetsThisHand(room, newlyEliminated);
    broadcastState(room.id);

    io.to(room.id).emit('bigAnnouncement', {
      title: '⚡ 31 HIT FROM DISCARD! ⚡',
      message: `LOSER: ${penalizedGiver.name.toUpperCase()} LOST 2 LIVES!`,
      subtext: `${roundBetReport ? roundBetReport + ' | ' : ''}${firstLoserReport ? firstLoserReport + ' | ' : ''}Fed BOTH Ace & Face card from Discard to ${player.name}!`,
      hands: revealedHands,
      duration: 7500
    });
  } else {
    const losers = [];
    room.players.forEach(p => {
      if (!p.isSpectator && p.lives > 0 && p.id !== player.id) {
        p.lives -= 1;
        if (p.lives <= 0) {
          newlyEliminated.push(p.name);
        }
        losers.push(p.name);
      }
    });

    const firstLoserReport = settleFirstLoserBetsThisHand(room, newlyEliminated);
    broadcastState(room.id);

    const drawDesc = player.lastDrawnSource === 'deck' 
      ? 'Drawn from Deck!' 
      : (player.lastDrawnSource === 'deal' ? 'Dealt 31!' : 'Natural 31!');

    io.to(room.id).emit('bigAnnouncement', {
      title: `⚡ ${player.name.toUpperCase()} HIT 31! ⚡`,
      message: `EVERYONE ELSE LOSES 1 LIFE!`,
      subtext: `${roundBetReport ? roundBetReport + ' | ' : ''}${firstLoserReport ? firstLoserReport + ' | ' : ''}${drawDesc} Losers: ${losers.join(', ')}`,
      hands: revealedHands,
      duration: 7500
    });
  }

  setTimeout(() => startNewRound(room.id), 7500);
  return true;
}

function startNewRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  if (room.spectatorPeeks) {
    for (const specId of Object.keys(room.spectatorPeeks)) {
      io.to(specId).emit('spectatorHandRevoked');
    }
    room.spectatorPeeks = {};
  }

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
      const winIdx = room.players.findIndex(p => p.id === winner.id);
      if (winIdx >= 0) {
        room.dealerIdx = winIdx;
        room.lastGameWinnerId = winner.id;
      }
    }

    io.to(roomId).emit('bigAnnouncement', {
      title: '🏆 GAME OVER 🏆',
      message: `${winnerName.toUpperCase()} WINS!${potWonText}`,
      subtext: `${winnerName} will deal the next match!`,
      duration: 8000
    });

    room.gameStarted = false;
    room.currentMatchParticipants = [];
    room.peerSideBets = [];

    let activeAssigned = 0;
    room.players.forEach(p => { 
      if (!p.manualSpectator && activeAssigned < MAX_ACTIVE_PLAYERS) {
        p.isSpectator = false;
        p.lives = room.configuredLives || 2;
        activeAssigned++;
      } else {
        p.isSpectator = true;
        p.lives = 0;
      }
      p.isReady = false; 
    });

    broadcastState(roomId, `Game over! ${winnerName} won and deals the next match!`);
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
  room.peerSideBets = (room.peerSideBets || []).filter(b => b.type === 'firstLoser');
  room.tiebreakerActive = false;
  room.firstCardPickedUp = null;
  room.firstCardPickupTracker = null;

  if (!room.isFirstRoundOfMatch) {
    for (let i = 1; i <= room.players.length; i++) {
      const nextD = (room.dealerIdx + i) % room.players.length;
      const candidate = room.players[nextD];
      if (candidate && !candidate.isSpectator && candidate.lives > 0) {
        room.dealerIdx = nextD;
        break;
      }
    }
  } else {
    room.isFirstRoundOfMatch = false;
  }

  const dealer = room.players[room.dealerIdx];
  const dealOrder = [...active].sort((a, b) => (a.joinOrder || 0) - (b.joinOrder || 0));

  dealOrder.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
    p.fedCardsTracker = {};
    p.discardPickedCards = [];
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
  room.currentDiscardFeederId = null;
  room.initialDiscardCard = firstDiscard;

  for (const p of active) {
    if (calculateScore(p.hand) === 31) {
      broadcastState(roomId, `⚡ ${p.name} was dealt 31!`);
      checkAndHandle31(room, p);
      return;
    }
  }

  room.currentTurnIdx = room.dealerIdx;
  advanceTurnIndex(room);

  broadcastState(roomId, `New round! Dealer: ${dealer?.name || 'Dealer'}. Propose side bets!`);
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

  const activeSideBetsTotal = (room.peerSideBets || [])
    .filter(b => b.accepted)
    .reduce((sum, b) => sum + (b.amount * 2), 0);

  if (room.firstCardPickupTracker) {
    const targetPlayer = room.players.find(p => p.name === room.firstCardPickupTracker.player);
    if (!targetPlayer || !targetPlayer.hand || !targetPlayer.hand.some(c => c.rank === room.firstCardPickupTracker.card.rank && c.suit === room.firstCardPickupTracker.card.suit)) {
      room.firstCardPickupTracker = null;
    }
  }

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
      allTableMembers: (room.knownMembers || []).map(name => {
        const pl = room.players.find(x => x.name === name);
        return {
          name: name,
          isOnline: Boolean(pl && !pl.disconnected),
          isSpectator: Boolean(pl && pl.isSpectator),
          lives: pl ? pl.lives : 0
        };
      }),
      hand: p.isSpectator ? [] : p.hand,
      score: score,
      minKnockScore: minKnockScore,
      roundHasPassed: roundHasPassed,
      topDiscard: room.discardPile[room.discardPile.length - 1] || null,
      firstCardPickedUp: room.firstCardPickupTracker || null,
      deckCount: room.deck ? room.deck.length : 0,
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
      sideBetActionTotal: activeSideBetsTotal,
      activeSideBets: (room.peerSideBets || []).map(b => ({
        id: b.id,
        type: b.type,
        bettor: b.bettorName,
        opponent: b.opponentName,
        targetPlayer: b.targetPlayerName,
        amount: b.amount,
        accepted: b.accepted
      })),
      personalLedger: personalLedgerData.balances,
      netOverallBalance: personalLedgerData.totalNet,
      netSideBetBalance: personalLedgerData.totalSideBetNet,
      message: message,
      endGameVote: room.endGameVote || null
    });
  });

  broadcastSpectatorPeeks(room);
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
  const knocker = room.players.find(p => p.id === room.knockerId);
  const revealedHands = getRevealedHands(room);
  const roundBetReport = settlePeerRoundBets(room, scores);

  let newlyEliminated = [];

  if (knocker && lowestPlayers.some(p => p.id === knocker.id) && lowestPlayers.length === 1) {
    knocker.lives -= 1;
    if (knocker.lives <= 0) {
      newlyEliminated.push(knocker.name);
    }
    const firstLoserReport = settleFirstLoserBetsThisHand(room, newlyEliminated);
    const losersText = `${knocker.name} (Knocker lost alone)`;

    io.to(roomId).emit('bigAnnouncement', {
      title: '💀 ROUND OVER 💀',
      message: `LOSER: ${losersText}`,
      subtext: `${roundBetReport ? roundBetReport + ' | ' : ''}${firstLoserReport ? firstLoserReport + ' | ' : ''}Lowest Score: ${minScore}`,
      hands: revealedHands,
      duration: 7500
    });
    broadcastState(roomId, `Showdown finished! Loser: ${losersText}`);
    setTimeout(() => startNewRound(roomId), 7500);
    return;
  }

  if (lowestPlayers.length > 1) {
    if (active.length === 2) {
      io.to(roomId).emit('bigAnnouncement', {
        title: '🤝 HEADS-UP TIE! 🤝',
        message: 'PUSH — RE-DEALING ROUND!',
        subtext: `${roundBetReport ? roundBetReport + ' | ' : ''}Both players tied at ${minScore} points`,
        hands: revealedHands,
        duration: 7500
      });
      broadcastState(roomId, `Heads-up tie at ${minScore}! Re-dealing with no lives lost.`);
      setTimeout(() => startNewRound(roomId), 4500);
      return;
    }

    startInteractiveTiebreaker(room, lowestPlayers);
    return;
  }

  const singleLoser = lowestPlayers[0];
  singleLoser.lives -= 1;
  if (singleLoser.lives <= 0) {
    newlyEliminated.push(singleLoser.name);
  }
  const firstLoserReport = settleFirstLoserBetsThisHand(room, newlyEliminated);

  io.to(roomId).emit('bigAnnouncement', {
    title: '💀 ROUND OVER 💀',
    message: `LOSER: ${singleLoser.name}`,
    subtext: `${roundBetReport ? roundBetReport + ' | ' : ''}${firstLoserReport ? firstLoserReport + ' | ' : ''}Lowest Score: ${minScore}`,
    hands: revealedHands,
    duration: 7500
  });

  broadcastState(roomId, `Showdown finished! Loser: ${singleLoser.name}`);
  setTimeout(() => startNewRound(roomId), 7500);
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
      if (room.initialDiscardCard && topDiscard.rank === room.initialDiscardCard.rank && topDiscard.suit === room.initialDiscardCard.suit) {
        room.firstCardPickupTracker = { player: current.name, card: topDiscard };
        room.initialDiscardCard = null;
      }

      drawn = room.discardPile.pop();
      current.lastDrawnSource = 'discard';
      if (!current.discardPickedCards) current.discardPickedCards = [];
      current.discardPickedCards.push(drawn);

      const feederId = room.currentDiscardFeederId || getPrevActivePlayer(room, room.currentTurnIdx)?.id;
      if (feederId) {
        if (!current.fedCardsTracker) current.fedCardsTracker = {};
        if (!current.fedCardsTracker[feederId]) current.fedCardsTracker[feederId] = [];
        current.fedCardsTracker[feederId].push(drawn);
      }
      io.to(roomId).emit('animateDraw', { playerName: current.name, playerId: current.id, source: 'discard', card: drawn });
    } else {
      if (room.deck.length === 0) {
        const top = room.discardPile.pop();
        room.deck = room.discardPile.concat(room.discardPile.sort(() => Math.random() - 0.5));
        room.discardPile = [top];
        io.to(roomId).emit('bannerAnnouncement', {
          text: `🔄 The draw deck has run out and been reshuffled!`,
          duration: 4000
        });
      }
      drawn = room.deck.pop();
      current.lastDrawnSource = 'deck';
      io.to(roomId).emit('animateDraw', { playerName: current.name, playerId: current.id, source: 'deck', card: null });
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
  if (!room || !playerName) return;
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

  if (room.dealerCutActive) {
    checkDealerCutComplete(room);
  }
  if (room.tiebreakerActive) {
    checkTiebreakerComplete(room);
  }

  if (getActivePlayers(room).length === 0 && room.players.length === 0) {
    delete rooms[roomId];
  } else {
    broadcastState(roomId, `${leaving.name} left the room.`);
    if (room.gameStarted && getActivePlayers(room).length <= 1) {
      startNewRound(roomId);
    }
  }
  broadcastRoomList();
}

io.on('connection', (socket) => {
  broadcastRoomList();

  socket.on('requestStateSync', (roomId) => {
    if (roomId && rooms[roomId]) {
      broadcastState(roomId);
    }
  });

  socket.on('joinRoom', ({ roomId, playerName, deviceId, initialLives }) => {
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
        peerSideBets: [],
        debts: {},
        debtBreakdowns: {},
        knownMembers: [],
        playerRegistry: {},
        lastGameWinnerId: null,
        isFirstRoundOfMatch: false,
        spectatorPeeks: {},
        configuredLives: parseInt(initialLives) || 2,
        initialDiscardCard: null,
        firstCardPickupTracker: null,
        endGameVote: null
      };
    }
    const room = rooms[roomId];

    if (initialLives && !room.gameStarted) {
      room.configuredLives = parseInt(initialLives) || 2;
    }

    let safeName = playerName ? playerName.trim() : '';

    if (deviceId && room.playerRegistry[deviceId]) {
      if (safeName && safeName !== room.playerRegistry[deviceId]) {
        const oldName = room.playerRegistry[deviceId];

        const kmIdx = room.knownMembers.indexOf(oldName);
        if (kmIdx !== -1) room.knownMembers[kmIdx] = safeName;
        else if (!room.knownMembers.includes(safeName)) room.knownMembers.push(safeName);

        if (room.debts[oldName]) {
          room.debts[safeName] = { ...(room.debts[safeName] || {}), ...room.debts[oldName] };
          delete room.debts[oldName];
        }

        Object.keys(room.debts).forEach(debtor => {
          if (room.debts[debtor][oldName] !== undefined) {
            room.debts[debtor][safeName] = (room.debts[debtor][safeName] || 0) + room.debts[debtor][oldName];
            delete room.debts[debtor][oldName];
          }
        });

        if (room.debtBreakdowns) {
          Object.keys(room.debtBreakdowns).forEach(pairKey => {
            const [d, c] = pairKey.split(':::');
            if (d === oldName || c === oldName) {
              const newD = (d === oldName) ? safeName : d;
              const newC = (c === oldName) ? safeName : c;
              const newKey = `${newD}:::${newC}`;
              room.debtBreakdowns[newKey] = room.debtBreakdowns[pairKey];
              delete room.debtBreakdowns[pairKey];
            }
          });
        }

        room.playerRegistry[deviceId] = safeName;
      } else {
        safeName = room.playerRegistry[deviceId];
      }
    } else {
      if (!safeName) safeName = `Player ${room.players.length + 1}`;
      if (deviceId) room.playerRegistry[deviceId] = safeName;
    }

    if (!room.knownMembers.includes(safeName)) {
      room.knownMembers.push(safeName);
    }

    let existingPlayer = null;
    if (deviceId) {
      existingPlayer = room.players.find(p => p.deviceId === deviceId);
    }
    if (!existingPlayer) {
      existingPlayer = room.players.find(p => p.name === safeName);
    }

    if (existingPlayer) {
      const key = `${roomId}:::${existingPlayer.name}`;
      if (disconnectTimeouts[key]) {
        clearTimeout(disconnectTimeouts[key]);
        delete disconnectTimeouts[key];
      }
      existingPlayer.name = safeName;
      existingPlayer.id = socket.id;
      if (deviceId) existingPlayer.deviceId = deviceId;
      existingPlayer.disconnected = false;

      broadcastState(roomId, `${safeName} reconnected.`);
      broadcastRoomList();
      return;
    }

    const currentActiveCount = getNonSpectatorCount(room);
    const roomIsFull = currentActiveCount >= MAX_ACTIVE_PLAYERS;
    const isSpectator = Boolean(room.gameStarted || roomIsFull);

    playerJoinCounter++;
    room.players.push({
      id: socket.id,
      deviceId: deviceId || null,
      name: safeName,
      lives: isSpectator ? 0 : (room.configuredLives || 2),
      hand: [],
      fedCardsTracker: {},
      discardPickedCards: [],
      lastDrawnSource: null,
      isBot: false,
      isSpectator: isSpectator,
      manualSpectator: false,
      isReady: false,
      isInVoice: false,
      disconnected: false,
      matchWager: 0,
      joinOrder: playerJoinCounter
    });

    let joinMsg = `${safeName} joined the room.`;
    if (roomIsFull && !room.gameStarted) {
      joinMsg = `👁️ Room active limit (6) reached. ${safeName} is spectating.`;
    } else if (room.gameStarted) {
      joinMsg = `👁️️ ${safeName} joined as a spectator.`;
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
      playerJoinCounter++;
      player.joinOrder = playerJoinCounter;
      player.manualSpectator = false;
      player.isSpectator = false;
      player.lives = room.configuredLives || 2;
      player.isReady = false;
      broadcastState(roomId, `🃏 ${player.name} rejoined as an active player.`);
    }
    broadcastRoomList();
  });

  socket.on('requestPeekingPermission', ({ roomId, targetPlayerId }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    const spectator = room.players.find(p => p.id === socket.id && p.isSpectator);
    const target = room.players.find(p => p.id === targetPlayerId && !p.isSpectator && p.lives > 0);
    if (!spectator || !target) return;

    if (room.spectatorPeeks && room.spectatorPeeks[socket.id]) {
      delete room.spectatorPeeks[socket.id];
      socket.emit('spectatorHandRevoked');
    }

    if (target.isBot) {
      if (!room.spectatorPeeks) room.spectatorPeeks = {};
      room.spectatorPeeks[socket.id] = target.id;
      socket.emit('spectatorHandUpdate', {
        targetPlayerName: target.name,
        targetPlayerId: target.id,
        hand: target.hand,
        score: calculateScore(target.hand)
      });
      socket.emit('bannerAnnouncement', { text: `Now peeking at ${target.name}'s hand.`, duration: 2500 });
      return;
    }

    io.to(target.id).emit('peekingPermissionRequested', {
      spectatorId: socket.id,
      spectatorName: spectator.name
    });
    socket.emit('bannerAnnouncement', { text: `Requested permission to view ${target.name}'s hand...`, duration: 3000 });
  });

  socket.on('respondPeekingPermission', ({ roomId, spectatorId, allow }) => {
    const room = rooms[roomId];
    if (!room || !room.spectatorPeeks) return;

    const targetPlayer = room.players.find(p => p.id === socket.id);
    const spectator = room.players.find(p => p.id === spectatorId);
    if (!targetPlayer || !spectator) return;

    if (allow) {
      room.spectatorPeeks[spectatorId] = targetPlayer.id;
      io.to(spectatorId).emit('spectatorHandUpdate', {
        targetPlayerName: targetPlayer.name,
        targetPlayerId: targetPlayer.id,
        hand: targetPlayer.hand,
        score: calculateScore(targetPlayer.hand)
      });
      io.to(spectatorId).emit('bannerAnnouncement', { text: `👁️ ${targetPlayer.name} granted you view permission!`, duration: 3000 });
    } else {
      io.to(spectatorId).emit('bannerAnnouncement', { text: `❌ ${targetPlayer.name} declined view permission.`, duration: 3000 });
    }
  });

  socket.on('stopPeekingHand', (roomId) => {
    const room = rooms[roomId];
    if (room && room.spectatorPeeks && room.spectatorPeeks[socket.id]) {
      delete room.spectatorPeeks[socket.id];
      socket.emit('spectatorHandRevoked');
    }
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

  socket.on('clearDebt', ({ roomId, debtorName }) => {
    const room = rooms[roomId];
    if (!room) return;

    const creditor = room.players.find(p => p.id === socket.id);
    if (!creditor) return;
    const creditorName = creditor.name;

    let clearedAmount = 0;

    if (room.debts && room.debts[debtorName] && room.debts[debtorName][creditorName]) {
      clearedAmount += room.debts[debtorName][creditorName];
      room.debts[debtorName][creditorName] = 0;
    }

    if (room.debtBreakdowns) {
      const key = `${debtorName}:::${creditorName}`;
      if (room.debtBreakdowns[key]) {
        room.debtBreakdowns[key] = { match: 0, sideBets: 0 };
      }
    }

    if (clearedAmount > 0) {
      broadcastState(roomId, `🤝 ${creditorName} forgave and cleared ${debtorName}'s debt of $${clearedAmount}!`);
      io.to(roomId).emit('bannerAnnouncement', {
        text: `🤝 ${creditorName} cleared ${debtorName}'s debt of $${clearedAmount}!`,
        duration: 4000
      });
    } else {
      socket.emit('errorMsg', `No active debt found from ${debtorName}.`);
    }
  });

  socket.on('proposeMultiSideBets', ({ roomId, betType, opponentNames, targetPlayerName, amount }) => {
    const room = rooms[roomId];
    if (!room) return;

    const bettor = room.players.find(p => p.id === socket.id);
    if (!bettor) return;

    if (!Array.isArray(opponentNames) || opponentNames.length === 0) {
      return socket.emit('errorMsg', 'Select at least one opponent for your side bet.');
    }

    const targetPlayer = room.players.find(p => p.name === targetPlayerName && !p.isSpectator);
    if (!targetPlayer && betType === 'round') {
      return socket.emit('errorMsg', 'Invalid target player for side bet.');
    }

    const parsedAmt = Math.max(1, parseInt(amount) || 1);
    if (!room.peerSideBets) room.peerSideBets = [];

    let proposedCount = 0;
    let botAcceptedCount = 0;

    opponentNames.forEach(oppName => {
      if (oppName === bettor.name) return;
      const opponent = room.players.find(p => p.name === oppName);
      if (!opponent) return;

      if (betType === 'firstLoser') {
        const existingDuplicate = room.peerSideBets.find(b => 
          b.type === 'firstLoser' &&
          ((b.bettorId === bettor.id && b.opponentId === opponent.id) || (b.bettorId === opponent.id && b.opponentId === bettor.id)) &&
          b.targetPlayerName === targetPlayerName
        );
        if (existingDuplicate) {
          return socket.emit('errorMsg', `You already have a First-to-Lose bet active or pending with ${opponent.name} on ${targetPlayerName}!`);
        }
      }

      const betId = `sb_${Date.now()}_${Math.random()}`;
      const newBet = {
        id: betId,
        type: betType || 'round',
        bettorId: bettor.id,
        bettorName: bettor.name,
        opponentId: opponent.id,
        opponentName: opponent.name,
        targetPlayerName: betType === 'firstLoser' ? targetPlayerName : targetPlayer.name,
        bettorTargetId: betType === 'firstLoser' ? null : targetPlayer.id,
        opponentTargetId: null,
        amount: parsedAmt,
        accepted: Boolean(opponent.isBot)
      };

      if (opponent.isBot) {
        const possibleBotTargets = getActivePlayers(room).filter(p => p.name !== targetPlayerName);
        const botPick = possibleBotTargets[Math.floor(Math.random() * possibleBotTargets.length)] || targetPlayer;
        newBet.opponentTargetName = botPick.name;
        newBet.opponentTargetId = botPick.id;
        botAcceptedCount++;
      }

      room.peerSideBets.push(newBet);
      proposedCount++;

      if (!opponent.isBot) {
        io.to(opponent.id).emit('sideBetOfferReceived', {
          betId: betId,
          fromPlayer: bettor.name,
          amount: parsedAmt,
          betType: betType,
          bettorTarget: betType === 'firstLoser' ? targetPlayerName : targetPlayer.name
        });
      }
    });

    if (proposedCount === 0) {
      return socket.emit('errorMsg', 'Invalid side bet selection.');
    }

    let msg = `Sent ${proposedCount} side bet proposals ($${parsedAmt} each).`;
    if (botAcceptedCount > 0) {
      msg += ` (${botAcceptedCount} bot(s) accepted immediately)`;
    }

    socket.emit('bannerAnnouncement', { text: msg, duration: 3200 });
    broadcastState(roomId, `🎲 ${bettor.name} offered $${parsedAmt} side bets to ${proposedCount} player(s).`);
  });

  socket.on('respondSideBet', ({ roomId, betId, accept, myTargetName }) => {
    const room = rooms[roomId];
    if (!room || !room.peerSideBets) return;

    const betIdx = room.peerSideBets.findIndex(b => b.id === betId);
    if (betIdx === -1) return;
    const bet = room.peerSideBets[betIdx];

    if (bet.opponentId !== socket.id) return;

    if (accept) {
      const oppTarget = room.players.find(p => p.name === myTargetName);
      if (!oppTarget && bet.type === 'round') {
        return socket.emit('errorMsg', 'Please select a valid pick for your side of the bet.');
      }

      if (bet.type === 'round' && oppTarget.name === bet.targetPlayerName) {
        room.peerSideBets.splice(betIdx, 1);
        socket.emit('errorMsg', 'You cannot bet on the same player as the challenger!');
        io.to(bet.bettorId).emit('bannerAnnouncement', {
          text: `❌ ${bet.opponentName} tried to pick the same player as you and the bet was cancelled.`,
          duration: 3500
        });
        broadcastState(roomId, `${bet.opponentName} tried to pick the same contender as ${bet.bettorName} (side bet cancelled).`);
        return;
      }

      if (bet.type === 'round') {
        bet.opponentTargetName = oppTarget.name;
        bet.opponentTargetId = oppTarget.id;
      }
      bet.accepted = true;

      io.to(room.id).emit('bannerAnnouncement', {
        text: `🤝 ${bet.opponentName} ACCEPTED ${bet.bettorName}'s $${bet.amount} side bet!`,
        duration: 3500
      });
      broadcastState(roomId, `🤝 ${bet.opponentName} accepted side bet vs ${bet.bettorName} ($${bet.amount}).`);
    } else {
      room.peerSideBets.splice(betIdx, 1);
      io.to(bet.bettorId).emit('bannerAnnouncement', {
        text: `❌ ${bet.opponentName} declined your $${bet.amount} side bet.`,
        duration: 3000
      });
      broadcastState(roomId, `${bet.opponentName} declined side bet with ${bet.bettorName}.`);
    }
  });

  socket.on('pickDealerCutCard', ({ roomId, cardIndex }) => {
    const room = rooms[roomId];
    if (!room || !room.dealerCutActive || !room.dealerCutPlayerIds.includes(socket.id)) return;
    if (room.dealerCutPicks[socket.id]) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const safeIdx = Math.min(Math.max(0, cardIndex), room.dealerCutDeck.length - 1);
    const card = room.dealerCutDeck.splice(safeIdx, 1)[0];
    room.dealerCutPicks[socket.id] = { player: player, card: card };

    io.to(room.id).emit('dealerCutCardPicked', {
      playerId: socket.id,
      playerName: player.name,
      remainingCount: room.dealerCutDeck.length
    });

    checkDealerCutComplete(room);
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

    io.to(room.id).emit('tiebreakerCardPicked', {
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

    if (player) {
      io.to(roomId).emit('bannerAnnouncement', {
        text: `🎙️ ${player.name} joined the voice channel!`,
        duration: 3500
      });
      io.to(roomId).emit('playVoiceBell');
    }

    broadcastState(roomId);
  });

  socket.on('leaveVoice', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.isInVoice = false;

    socket.to(roomId).emit('voiceUserLeft', { socketId: socket.id });

    if (player) {
      io.to(roomId).emit('bannerAnnouncement', {
        text: `🔇 ${player.name} left the voice channel.`,
        duration: 3000
      });
      io.to(roomId).emit('playVoiceBell');
    }

    broadcastState(roomId);
  });

  socket.on('inviteToVoice', ({ roomId, targetSocketId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const inviter = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetSocketId || p.name === targetSocketId);
    if (!inviter || !target || target.isInVoice) return;

    io.to(target.id).emit('voiceInviteReceived', {
      inviterName: inviter.name,
      roomId: roomId
    });
    socket.emit('bannerAnnouncement', { text: `Voice invite sent to ${target.name}!`, duration: 3000 });
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
      room.isFirstRoundOfMatch = true;
      room.currentMatchParticipants = getActivePlayers(room).map(p => ({
        id: p.id,
        name: p.name,
        wager: p.matchWager || 0
      }));

      const previousWinner = room.lastGameWinnerId ? room.players.find(p => p.id === room.lastGameWinnerId && !p.isSpectator) : null;
      if (previousWinner) {
        room.dealerIdx = room.players.findIndex(p => p.id === previousWinner.id);
        io.to(roomId).emit('bigAnnouncement', {
          title: '👑 RETURNING CHAMPION 👑',
          message: `${previousWinner.name.toUpperCase()} DEALS!`,
          subtext: 'Winner of the last game deals the new game',
          duration: 3500
        });
        setTimeout(() => startNewRound(roomId), 3800);
      } else {
        startDealerCut(room);
      }
    }
    broadcastRoomList();
  });

  socket.on('proposeEndGame', (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.isSpectator) return;

    if (!room.endGameVote) {
      room.endGameVote = {
        proposer: player.name,
        agreedIds: []
      };
    }

    if (!room.endGameVote.agreedIds.includes(player.id)) {
      room.endGameVote.agreedIds.push(player.id);
    }

    room.players.forEach(p => {
      if (p.isBot && !room.endGameVote.agreedIds.includes(p.id)) {
        room.endGameVote.agreedIds.push(p.id);
      }
    });

    const eligible = room.players.filter(p => !p.isSpectator && p.lives > 0);
    const agreedCount = room.endGameVote.agreedIds.length;

    if (agreedCount >= eligible.length) {
      io.to(roomId).emit('bigAnnouncement', {
        title: '🏳️ GAME ENDED',
        message: 'MATCH CONCLUDED BY VOTE',
        subtext: 'Returning everyone to the lobby...',
        duration: 4000
      });

      room.gameStarted = false;
      room.currentMatchParticipants = [];
      room.peerSideBets = [];
      room.endGameVote = null;

      room.players.forEach(p => {
        p.isSpectator = false;
        p.lives = room.configuredLives || 2;
        p.isReady = false;
      });

      broadcastState(roomId, 'Game ended by unanimous vote.');
      broadcastRoomList();
    } else {
      io.to(roomId).emit('bannerAnnouncement', {
        text: `🏳️ ${player.name} requested to end the game (${agreedCount}/${eligible.length} agreed)`,
        duration: 4000
      });
      broadcastState(roomId);
    }
  });

  socket.on('respondEndGame', ({ roomId, agree }) => {
    const room = rooms[roomId];
    if (!room || !room.endGameVote) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (agree) {
      if (!room.endGameVote.agreedIds.includes(player.id)) {
        room.endGameVote.agreedIds.push(player.id);
      }
      room.players.forEach(p => {
        if (p.isBot && !room.endGameVote.agreedIds.includes(p.id)) {
          room.endGameVote.agreedIds.push(p.id);
        }
      });

      const eligible = room.players.filter(p => !p.isSpectator && p.lives > 0);
      const agreedCount = room.endGameVote.agreedIds.length;

      if (agreedCount >= eligible.length) {
        io.to(roomId).emit('bigAnnouncement', {
          title: '🏳️ GAME ENDED',
          message: 'MATCH CONCLUDED BY VOTE',
          subtext: 'Returning everyone to the lobby...',
          duration: 4000
        });

        room.gameStarted = false;
        room.currentMatchParticipants = [];
        room.peerSideBets = [];
        room.endGameVote = null;

        room.players.forEach(p => {
          p.isSpectator = false;
          p.lives = room.configuredLives || 2;
          p.isReady = false;
        });

        broadcastState(roomId, 'Game ended by unanimous vote.');
        broadcastRoomList();
      } else {
        broadcastState(roomId, `${player.name} agreed to end the game (${agreedCount}/${eligible.length}).`);
      }
    } else {
      const proposer = room.endGameVote.proposer;
      room.endGameVote = null;
      io.to(roomId).emit('bannerAnnouncement', {
        text: `❌ ${player.name} declined to end the game.`,
        duration: 3500
      });
      broadcastState(roomId, `${player.name} declined to end the game proposed by ${proposer}.`);
    }
  });

  socket.on('leaveRoom', (roomId) => {
    socket.leave(roomId);
    const room = rooms[roomId];
    const player = room?.players.find(p => p.id === socket.id);
    if (room && player) {
      finalizePlayerExit(roomId, player.name);
    }
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

    playerJoinCounter++;
    const botCount = room.players.filter(p => p.isBot).length + 1;
    const botName = `Bot ${botCount}`;
    if (!room.knownMembers.includes(botName)) {
      room.knownMembers.push(botName);
    }

    room.players.push({
      id: `bot_${Date.now()}_${Math.random()}`,
      name: botName,
      lives: room.configuredLives || 2,
      hand: [],
      fedCardsTracker: {},
      lastDrawnSource: null,
      isBot: true,
      isSpectator: false,
      manualSpectator: false,
      isReady: true,
      isInVoice: false,
      disconnected: false,
      matchWager: 5,
      joinOrder: playerJoinCounter
    });

    broadcastState(roomId, `Bot ${botCount} joined.`);
    if (checkAllPlayersReady(room)) {
      room.gameStarted = true;
      room.isFirstRoundOfMatch = true;
      room.currentMatchParticipants = getActivePlayers(room).map(p => ({
        id: p.id,
        name: p.name,
        wager: p.matchWager || 0
      }));

      const previousWinner = room.lastGameWinnerId ? room.players.find(p => p.id === room.lastGameWinnerId && !p.isSpectator) : null;
      if (previousWinner) {
        room.dealerIdx = room.players.findIndex(p => p.id === previousWinner.id);
        startNewRound(roomId);
      } else {
        startDealerCut(room);
      }
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
      room.isFirstRoundOfMatch = true;
      room.currentMatchParticipants = getActivePlayers(room).map(p => ({
        id: p.id,
        name: p.name,
        wager: p.matchWager || 0
      }));
      startDealerCut(room);
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
      const topDiscardCheck = room.discardPile[room.discardPile.length - 1];

      if (room.initialDiscardCard && topDiscardCheck.rank === room.initialDiscardCard.rank && topDiscardCheck.suit === room.initialDiscardCard.suit) {
        room.firstCardPickupTracker = { player: player.name, card: topDiscardCheck };
        room.initialDiscardCard = null;
      }

      drawn = room.discardPile.pop();
      player.lastDrawnSource = 'discard';
      if (!player.discardPickedCards) player.discardPickedCards = [];
      player.discardPickedCards.push(drawn);

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
      io.to(roomId).emit('animateDraw', { playerName: player.name, playerId: player.id, source: 'discard', card: drawn });
    } else {
      if (room.deck.length === 0) {
        const top = room.discardPile.pop();
        room.deck = room.discardPile.concat(room.discardPile.sort(() => Math.random() - 0.5));
        room.discardPile = [top];
        io.to(roomId).emit('bannerAnnouncement', {
          text: `🔄 The draw deck has run out and been reshuffled!`,
          duration: 4000
        });
      }
      drawn = room.deck.pop();
      player.lastDrawnSource = 'deck';
      broadcastState(roomId, `${player.name} drew a card from the deck.`);
      io.to(roomId).emit('animateDraw', { playerName: player.name, playerId: player.id, source: 'deck', card: null });
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
