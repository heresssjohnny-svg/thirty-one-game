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

function checkAllPlayersReady(room) {
  const eligible = room.players.filter(p => !p.isSpectator && (room.gameStarted ? p.lives > 0 : true));
  if (eligible.length < 2) return false;
  return eligible.every(p => p.isReady || p.isBot);
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

function broadcastRoomList() {
  const roomList = Object.entries(rooms).map(([id, r]) => {
    const activeCount = r.players.filter(p => !p.isSpectator).length;
    const spectatorCount = r.players.filter(p => p.isSpectator).length;
    let totalPot = activeCount * 5;
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

  io.to(room.id).emit('dealerCutResultsReveal', { results: revealData });

  if (lowestPickers.length > 1) {
    setTimeout(() => {
      if (!room) return;
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

function startNewRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActivePlayers(room);
  if (active.length <= 1) {
    const winner = active[0] || null;
    const winnerName = winner ? winner.name : 'Nobody';

    io.to(roomId).emit('bigAnnouncement', {
      title: '🏆 GAME OVER 🏆',
      message: `${winnerName.toUpperCase()} WINS!`,
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
  });

  room.discardPile.push(room.deck.pop());
  room.currentTurnIdx = room.dealerIdx;

  broadcastState(roomId, `New round! Dealer: ${dealer?.name || 'Dealer'}.`);
  broadcastRoomList();
}

function broadcastState(roomId, message = '') {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActivePlayers(room);
  const currentTurnPlayer = room.players[room.currentTurnIdx];
  const minKnockScore = active.length === 2 ? 25 : 21;
  const roundHasPassed = room.turnsTakenInRound >= active.length;
  
  let totalGamePot = active.reduce((sum, p) => sum + (p.matchWager || 0), 0);
  let activeSideBetsTotal = (room.peerSideBets || []).filter(b => b.accepted).reduce((sum, b) => sum + (b.amount * 2), 0);
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
      deckCount: deckCount,
      isMyTurn: isCurrent,
      hasDrawn: Boolean(room.drawnCard),
      canKnock: canKnock,
      isSpectator: Boolean(p.isSpectator),
      manualSpectator: Boolean(p.manualSpectator),
      gameStarted: room.gameStarted,
      knocker: room.knockerId ? room.players.find(pl => pl.id === room.knockerId)?.name : null,
      isReady: Boolean(p.isReady),
      totalPot: totalGamePot,
      sideBetActionTotal: activeSideBetsTotal,
      personalLedger: personalLedgerData.balances,
      message: message || (isCurrent ? '⭐ Your Turn! Draw a card.' : `Waiting for ${currentTurnPlayer?.name || 'opponent'}...`)
    });
  });
}

io.on('connection', (socket) => {
  broadcastRoomList();

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
        peerSideBets: []
      };
    }
    const room = rooms[roomId];
    let safeName = playerName ? playerName.trim() : `Player ${room.players.length + 1}`;

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
    const room = rooms[roomId];
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) delete rooms[roomId];
    }
    broadcastRoomList();
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
    if (room.players.length >= MAX_ACTIVE_PLAYERS) return;

    playerJoinCounter++;
    const botCount = room.players.filter(p => p.isBot).length + 1;
    const botName = `Bot ${botCount}`;
    room.knownMembers.push(botName);

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

  socket.on('proposeMultiSideBets', ({ roomId, betType, opponentNames, targetPlayerName, amount }) => {
    const room = rooms[roomId];
    if (!room) return;
    const bettor = room.players.find(p => p.id === socket.id);
    if (!bettor) return;

    if (!room.peerSideBets) room.peerSideBets = [];
    opponentNames.forEach(oppName => {
      const opp = room.players.find(p => p.name === oppName);
      if (opp) {
        room.peerSideBets.push({
          id: `sb_${Date.now()}_${Math.random()}`,
          type: betType,
          bettorId: bettor.id,
          bettorName: bettor.name,
          opponentId: opp.id,
          opponentName: opp.name,
          targetPlayerName: targetPlayerName,
          amount: amount,
          accepted: true
        });
      }
    });
    io.to(roomId).emit('bannerAnnouncement', { text: `🎲 Side bet proposed by ${bettor.name}!`, duration: 3500 });
    broadcastState(roomId);
  });

  socket.on('drawCard', ({ roomId, source }) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.drawnCard || room.isResolvingRound || player.isSpectator) return;

    let drawn;
    if (source === 'discard') {
      if (room.discardPile.length === 0) return;
      drawn = room.discardPile.pop();
      io.to(roomId).emit('bannerAnnouncement', {
        text: `👀 ${player.name} picked up ${drawn.rank}${drawn.suit} from the DISCARD pile!`,
        duration: 4000
      });
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

    advanceTurnIndex(room);
    broadcastState(roomId, `${player.name} discarded ${discarded.rank}${discarded.suit}.`);
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
