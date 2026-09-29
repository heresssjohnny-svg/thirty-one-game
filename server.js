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

  const totalP2OwesP1 = p2OwesP1Match + p2SideBets;
  const totalP1OwesP2 = p1OwesP2Match + p1SideBets;

  const netTotal = totalP2OwesP1 - totalP1OwesP2;
  const netSideBet = p2SideBets - p1SideBets;

  return {
    net: netTotal,
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

// ROUND SIDE BET SETTLEMENT: Compares bettor's target score vs opponent's target score
function settlePeerRoundBets(room, scores) {
  if (!room.peerSideBets || room.peerSideBets.length === 0) return '';
  const resultsSummary = [];

  room.peerSideBets.forEach(bet => {
    if (!bet.accepted || bet.type !== 'round') return;

    let bTargetId = bet.bettorTargetId;
    let oTargetId = bet.opponentTargetId;

    if (!bTargetId || scores[bTargetId] === undefined) {
      const matchP = room.players.find(p => p.name === bet.bettorTargetName);
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
      resultsSummary.push(`${bet.bettorName}'s pick (${bet.bettorTargetName}: ${bettorTargetScore} pts) beat ${bet.opponentName}'s pick (${bet.opponentTargetName}: ${opponentTargetScore} pts) -> +$${bet.amount}`);
    } else if (opponentTargetScore > bettorTargetScore) {
      recordDebt(room, bet.bettorName, bet.opponentName, bet.amount, 'sideBet');
      resultsSummary.push(`${bet.opponentName}'s pick (${bet.opponentTargetName}: ${opponentTargetScore} pts) beat ${bet.bettorName}'s pick (${bet.bettorTargetName}: ${bettorTargetScore} pts) -> +$${bet.amount}`);
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

function checkFirstToLoseBothLivesBets(room, eliminatedPlayerName) {
  if (!room.peerSideBets || room.peerSideBets.length === 0) return;
  if (room.firstLoserDetermined) return;

  room.firstLoserDetermined = true;
  const resultsSummary = [];

  room.peerSideBets.forEach(bet => {
    if (!bet.accepted || bet.type !== 'firstLoser') return;

    if (bet.targetPlayerName === eliminatedPlayerName) {
      recordDebt(room, bet.opponentName, bet.bettorName, bet.amount, 'sideBet');
      resultsSummary.push(`${bet.bettorName} correctly predicted ${bet.targetPlayerName} would lose both lives first (+$${bet.amount} from ${bet.opponentName})`);
    } else {
      recordDebt(room, bet.bettorName, bet.opponentName, bet.amount, 'sideBet');
      resultsSummary.push(`${bet.opponentName} won first-loser bet vs ${bet.bettorName} (+$${bet.amount})`);
    }
  });

  room.peerSideBets = room.peerSideBets.filter(b => b.type !== 'firstLoser');

  if (resultsSummary.length > 0) {
    io.to(room.id).emit('bannerAnnouncement', {
      text: `💀 ${eliminatedPlayerName} lost both lives! First-Loser Side Bets Settled.`,
      duration: 7500
    });
  }
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
  const requiredCount = room.tiebreakerPicks ? Object.keys(room.tiebreakerPicks).length : 0;
  if (requiredCount < room.tiedPlayerIds.length) return;

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
      subtext: `${roundBetReport ? roundBetReport + ' | ' : ''}${firstLoserReport ? firstLoserReport + ' | ' : ''}Fed Ace & 10 to ${player.name}!`,
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
      const totalCollected = recordGameWagerSettlement(room
