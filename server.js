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

  const durationMs = 45000;
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
    text: `⏱️ Time's up for ${current.name}! AI taking turn...`,
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

  room.debts[debtorName][creditorName] = (room.debts[debtorName][creditorName] || 0) + amount;

  const key = `${debtorName}:::${creditorName}`;
  if (!room.debtBreakdowns[key]) {
    room.debtBreakdowns[key] = { match: 0, sideBets: 0 };
  }
  if (reason === 'sideBet') {
    room.debtBreakdowns[key].sideBets += amount;
  } else {
    room.debtBreakdowns[key].match += amount;
  }
}

function recordGameWagerSettlement(room, winner) {
  let totalCollected = 0;
  if (!room.currentMatchParticipants) return 0;

  room.currentMatchParticipants.forEach(participant => {
    if (participant.name !== winner.name) {
      const wagerAmt = participant.wager || 0;
      if (wagerAmt > 0) {
        totalCollected += wagerAmt;
        recordDebt(room, participant.name, winner.name, wagerAmt, 'match');
      }
    }
  });
  return totalCollected;
}

function settlePeerRoundBets(room, scores) {
  if (!room.peerSideBets || room.peerSideBets.length === 0) return '';
  let reports = [];

  room.peerSideBets.forEach(bet => {
    if (!bet.accepted || bet.type !== 'round') return;

    const bettor = room.players.find(p => p.id === bet.bettorId);
    const opponent = room.players.find(p => p.id === bet.opponentId);
    if (!bettor || !opponent) return;

    const bettorTargetScore = scores[room.players.find(p => p.name === bet.targetPlayerName)?.id] || -1;
    const oppTargetScore = scores[room.players.find(p => p.name === bet.opponentTargetName)?.id] || -1;

    if (bettorTargetScore > oppTargetScore) {
      recordDebt(room, opponent.name, bettor.name, bet.amount, 'sideBet');
      reports.push(`${bettor.name} won $${bet.amount} side bet vs ${opponent.name}`);
    } else if (oppTargetScore > bettorTargetScore) {
      recordDebt(room, bettor.name, opponent.name, bet.amount, 'sideBet');
      reports.push(`${opponent.name} won $${bet.amount} side bet vs ${bettor.name}`);
    }
  });

  return reports.join(' | ');
}

function settleFirstLoserBetsThisHand(room, newlyEliminatedNames) {
  if (!room.peerSideBets || room.peerSideBets.length === 0 || !newlyEliminatedNames || newlyEliminatedNames.length === 0) return '';
  let reports = [];

  room.peerSideBets.forEach(bet => {
    if (!bet.accepted || bet.type !== 'firstLoser') return;

    const bettor = room.players.find(p => p.id === bet.bettorId);
    const opponent = room.players.find(p => p.id === bet.opponentId);
    if (!bettor || !opponent) return;

    if (newlyEliminatedNames.includes(bet.targetPlayerName)) {
      recordDebt(room, opponent.name, bettor.name, bet.amount, 'sideBet');
      reports.push(`${bettor.name} won First-Loser side bet vs ${opponent.name}`);
    }
  });

  return reports.join(' | ');
}

function getPersonalLedger(room, playerName) {
  if (!room.debts) return { balances: [], totalNet: 0, totalSideBetNet: 0 };
  const allNames = room.knownMembers || [];
  const balances = [];
  let totalNet = 0;
  let totalSideBetNet = 0;

  allNames.forEach(otherName => {
    if (otherName === playerName) return;

    let iOweThem = (room.debts[playerName] && room.debts[playerName][otherName]) || 0;
    let theyOweMe = (room.debts[otherName] && room.debts[otherName][playerName]) || 0;
    let net = theyOweMe - iOweThem;

    let sideBetNet = 0;
    const key1 = `${playerName}:::${otherName}`;
    const key2 = `${otherName}:::${playerName}`;
    if (room.debtBreakdowns) {
      if (room.debtBreakdowns[key1]) sideBetNet -= room.debtBreakdowns[key1].sideBets;
      if (room.debtBreakdowns[key2]) sideBetNet += room.debtBreakdowns[key2].sideBets;
    }

    totalNet += net;
    totalSideBetNet += sideBetNet;

    const otherPl = room.players.find(p => p.name === otherName);
    balances.push({
      player: otherName,
      netBalance: net,
      sideBetBalance: sideBetNet,
      hasLeft: !otherPl || otherPl.disconnected
    });
  });

  return { balances, totalNet, totalSideBetNet };
}

function finalizePlayerExit(roomId, playerName) {
  const room = rooms[roomId];
  if (!room) return;

  room.players = room.players.filter(p => p.name !== playerName);

  if (room.currentMatchParticipants) {
    room.currentMatchParticipants = room.currentMatchParticipants.filter(p => p.name !== playerName);
  }

  if (room.players.length === 0) {
    clearTurnTimer(room);
    delete rooms[roomId];
  } else {
    if (room.currentTurnIdx >= room.players.length) {
      room.currentTurnIdx = 0;
    }
    if (room.dealerIdx >= room.players.length) {
      room.dealerIdx = 0;
    }
    if (room.gameStarted && getActivePlayers(room).length <= 1) {
      startNewRound(roomId);
    } else {
      broadcastState(roomId, `${playerName} left the room.`);
    }
  }
  broadcastRoomList();
}

function handlePlayerDisconnect(socketId) {
  for (const [roomId, room] of Object.entries(rooms)) {
    const playerIdx = room.players.findIndex(p => p.id === socketId);
    if (playerIdx !== -1) {
      const player = room.players[playerIdx];
      player.disconnected = true;

      const key = `${roomId}:::${player.name}`;
      if (disconnectTimeouts[key]) clearTimeout(disconnectTimeouts[key]);

      disconnectTimeouts[key] = setTimeout(() => {
        delete disconnectTimeouts[key];
        finalizePlayerExit(roomId, player.name);
      }, 15000);

      broadcastState(roomId, `${player.name} disconnected.`);
      broadcastRoomList();
      break;
    }
  }
}

function broadcastRoomList() {
  const roomList = Object.entries(rooms).map(([id, r]) => {
    const activeCount = r.players.filter(p => !p.isSpectator).length;
    const spectatorCount = r.players.filter(p => p.isSpectator).length;
    
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
      spectatorCount: spectatorCount,
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

  eligible.forEach(p => {
    if (!p.isSpectator) {
      io.to(p.id).emit('startDealerSelectionCut', {
        deckCount: Math.min(cutDeck.length, 30),
        players: eligible.map(pl => ({ id: pl.id, name: pl.name }))
      });
    }
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
        duration: 4000
      });
      room.dealerCutActive = true;
      room.dealerCutPicks = {};
      room.dealerCutPlayerIds = lowestPickers.map(l => l.player.id);
      room.dealerCutDeck = createDeck();

      lowestPickers.forEach(l => {
        if (!l.player.isSpectator) {
          io.to(l.player.id).emit('startDealerSelectionCut', {
            deckCount: Math.min(room.dealerCutDeck.length, 30),
            players: lowestPickers.map(lp => ({ id: lp.player.id, name: lp.player.name }))
          });
        }
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
      duration: 4000
    });
    setTimeout(() => startNewRound(room.id), 3800);
  }, 3200);
}

function startInteractiveTiebreaker(room, tiedPlayers) {
  room.tiebreakerActive = true;
  room.tiebreakerPicks = {};
  const activeTied = tiedPlayers.filter(p => !p.isSpectator);
  room.tiedPlayerIds = activeTied.map(p => p.id);

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

  activeTied.forEach(p => {
    if (!p.isSpectator) {
      io.to(p.id).emit('startTiebreakerCut', {
        deckCount: room.tiebreakerDeck.length,
        tiedPlayers: activeTied.map(tp => ({ id: tp.id, name: tp.name }))
      });
    }
  });

  activeTied.forEach(p => {
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
        duration: 4000
      });
      room.tiebreakerActive = true;
      room.tiebreakerPicks = {};
      room.tiebreakerPlayerIds = cutLosers.map(l => l.player.id);
      room.tiebreakerDeck = createDeck();

      cutLosers.forEach(l => {
        if (!l.player.isSpectator) {
          io.to(l.player.id).emit('startTiebreakerCut', {
            deckCount: Math.min(room.tiebreakerDeck.length, 30),
            tiedPlayers: cutLosers.map(cl => ({ id: cl.player.id, name: cl.player.name }))
          });
        }
      });

      cutLosers.forEach(l => {
        if (l.player.isBot) {
          setTimeout(() => {
            if (!room.tiebreakerActive || room.tiebreakerPicks[l.player.id]) return;
            const chosenCardIdx = Math.floor(Math.random() * room.tiebreakerDeck.length);
            const card = room.tiebreakerDeck.splice(chosenCardIdx, 1)[0];
            room.tiebreakerPicks[l.player.id] = { player: l.player, card: card };
            checkTiebreakerComplete(room);
          }, 1000 + Math.random() * 800);
        }
      });
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

    room.players.forEach(p => { 
      if (!p.manualSpectator) {
        p.isSpectator = false;
        p.lives = room.configuredLives || 2;
      } else {
        p.isSpectator = true;
        p.lives = 0;
      }
      p.isReady = false; 
    });

    broadcastState(roomId, `Game over! ${winnerName} won.`);
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

  broadcastState(roomId, `New round! Dealer: ${dealer?.name || 'Dealer'}.`);
  broadcastRoomList();
  triggerBotTurnIfNeeded(room.id);
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

  let deckCount = room.deck ? room.deck.length : 52;

  room.players.forEach(p => {
    if (p.isBot) return;

    const isCurrent = currentTurnPlayer && currentTurnPlayer.id === p.id && !room.isResolvingRound && !p.isSpectator;
    const score = p.isSpectator ? 0 : calculateScore(p.hand);
    const canKnock = isCurrent && !room.knockerId && roundHasPassed && score >= minKnockScore && !room.drawnCard;

    const personalLedgerData = getPersonalLedger(room, p.name);

    io.to(p.id).emit('gameState', {
      myWager: p.matchWager || 0,
      configuredLives: room.configuredLives || 2,
      anyPlayerEliminated: false,
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
          id: pl ? pl.id : name,
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
      firstCardPickedUp: null,
      deckCount: deckCount,
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
      message: message
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
  let scores = {};

  active.forEach(p => {
    const sc = calculateScore(p.hand);
    scores[p.id] = sc;
    if (sc < minScore) minScore = sc;
  });

  const lowestPlayers = active.filter(p => scores[p.id] === minScore);
  const revealedHands = getRevealedHands(room);

  let singleLoser = lowestPlayers[0];
  singleLoser.lives -= 1;

  io.to(roomId).emit('bigAnnouncement', {
    title: '💀 ROUND OVER 💀',
    message: `LOSER: ${singleLoser.name}`,
    subtext: `Lowest Score: ${minScore}`,
    hands: revealedHands,
    duration: 7500
  });

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

    if (room.deck.length === 0) {
      const top = room.discardPile.pop();
      room.deck = room.discardPile.concat(room.discardPile.sort(() => Math.random() - 0.5));
      room.discardPile = [top];
    }
    const drawn = room.deck.pop();
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

io.on('connection', (socket) => {
  broadcastRoomList();

  socket.on('requestStateSync', (roomId) => {
    if (roomId && rooms[roomId]) {
      broadcastState(roomId);
    }
  });

  socket.on('joinRoom', ({ roomId, playerName, deviceId }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        players: [],
        deck: createDeck(),
        discardPile: [],
        dealerIdx: 0,
        currentTurnIdx: 0,
        gameStarted: false,
        configuredLives: 2,
        debts: {},
        debtBreakdowns: {},
        knownMembers: [],
        playerRegistry: {},
        peerSideBets: []
      };
    }
    const room = rooms[roomId];
    let safeName = playerName ? playerName.trim() : '';

    if (!room.knownMembers.includes(safeName)) {
      room.knownMembers.push(safeName);
    }

    let existing = room.players.find(p => p.deviceId === deviceId || p.name === safeName);
    if (existing) {
      existing.name = safeName;
      existing.id = socket.id;
      existing.disconnected = false;
    } else {
      playerJoinCounter++;
      room.players.push({
        id: socket.id,
        deviceId: deviceId || null,
        name: safeName,
        lives: room.configuredLives || 2,
        hand: [],
        isBot: false,
        isSpectator: room.gameStarted,
        manualSpectator: false,
        isReady: false,
        matchWager: 0,
        joinOrder: playerJoinCounter
      });
    }

    broadcastState(roomId, `${safeName} joined the room.`);
    broadcastRoomList();
  });

  socket.on('leaveRoom', (roomId) => {
    socket.leave(roomId);
    finalizePlayerExit(roomId, socket.id);
  });

  socket.on('toggleSpectate', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.manualSpectator = !player.manualSpectator;
    player.isSpectator = player.manualSpectator;
    player.lives = player.isSpectator ? 0 : (room.configuredLives || 2);
    player.isReady = false;

    broadcastState(roomId, `${player.name} is now ${player.isSpectator ? 'Spectating' : 'Playing'}.`);
    broadcastRoomList();
  });

  socket.on('setWager', ({ roomId, wager }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.matchWager = Math.max(0, parseInt(wager) || 0);
    broadcastState(roomId, `${player.name} set wager to $${player.matchWager}`);
  });

  socket.on('toggleReady', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.isSpectator) return;

    player.isReady = !player.isReady;
    broadcastState(roomId, `${player.name} is ${player.isReady ? 'READY' : 'NOT READY'}`);

    if (!room.gameStarted && checkAllPlayersReady(room)) {
      room.gameStarted = true;
      room.isFirstRoundOfMatch = true;
      startDealerCut(room);
    }
  });

  socket.on('addBot', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;

    if (room.players.length >= MAX_ACTIVE_PLAYERS) {
      return socket.emit('errorMsg', 'Max 6 players allowed.');
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
      isBot: true,
      isSpectator: false,
      manualSpectator: false,
      isReady: true,
      matchWager: 5,
      joinOrder: playerJoinCounter
    });

    broadcastState(roomId, `${botName} added.`);

    if (!room.gameStarted && checkAllPlayersReady(room)) {
      room.gameStarted = true;
      room.isFirstRoundOfMatch = true;
      startDealerCut(room);
    }
    broadcastRoomList();
  });

  socket.on('removeBot', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;

    const lastBotIdx = room.players.map(p => p.isBot).lastIndexOf(true);
    if (lastBotIdx !== -1) {
      room.players.splice(lastBotIdx, 1);
      broadcastState(roomId, `Bot removed.`);
    }
    broadcastRoomList();
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

  socket.on('proposeLifeChange', ({ roomId, lives }) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.isSpectator) return;

    room.configuredLives = parseInt(lives) || 2;
    room.players.forEach(pl => { pl.lives = room.configuredLives; });
    broadcastState(roomId, `Starting lives updated to ${room.configuredLives}.`);
  });

  socket.on('drawCard', ({ roomId, source }) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.drawnCard || room.isResolvingRound || player.isSpectator) return;

    let drawn;
    if (source === 'discard') {
      if (room.discardPile.length === 0) return;
      drawn = room.discardPile.pop();
    } else {
      if (room.deck.length === 0) {
        const top = room.discardPile.pop();
        room.deck = room.discardPile.concat(room.discardPile.sort(() => Math.random() - 0.5));
        room.discardPile = [top];
      }
      drawn = room.deck.pop();
    }

    room.drawnCard = drawn;
    player.hand.push(drawn);
    broadcastState(roomId, `${player.name} drew a card.`);
  });

  socket.on('discardCard', ({ roomId, cardIndex }) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || !room.drawnCard || room.isResolvingRound || player.isSpectator) return;

    if (cardIndex < 0 || cardIndex >= player.hand.length) return;

    const [discarded] = player.hand.splice(cardIndex, 1);
    room.discardPile.push(discarded);
    room.drawnCard = null;
    room.turnsTakenInRound += 1;

    if (checkAndHandle31(room, player)) return;

    advanceTurnIndex(room);
    broadcastState(roomId, `${player.name} discarded ${discarded.rank}${discarded.suit}.`);
    triggerBotTurnIfNeeded(roomId);
  });

  socket.on('knock', (roomId) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.knockerId || room.isResolvingRound || player.isSpectator) return;

    room.knockerId = player.id;
    io.to(roomId).emit('bannerAnnouncement', { text: `🔔 ${player.name} KNOCKED! Final turn for others.`, duration: 4000 });
    broadcastState(roomId, `${player.name} knocked.`);
  });

  socket.on('disconnect', () => {
    handlePlayerDisconnect(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server online on port ${PORT}`);
});
