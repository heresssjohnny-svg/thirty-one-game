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
  return room.players.filter(p => !p.isSpectator && p.lives > 0);
}

function getNonSpectatorCount(room) {
  return room.players.filter(p => !p.isSpectator).length;
}

function checkAllPlayersReady(room) {
  const eligible = room.players.filter(p => !p.isSpectator);
  if (eligible.length < 2) return false;
  return eligible.every(p => p.isReady || p.isBot);
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
    if (!p.isSpectator && !p.isBot) {
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
        if (!l.player.isSpectator && !l.player.isBot) {
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
    room.gameStarted = false;
    broadcastState(roomId, 'Game over: not enough active players.');
    broadcastRoomList();
    return;
  }

  room.deck = createDeck();
  room.discardPile = [];
  room.knockerId = null;
  room.drawnCard = null;
  room.isResolvingRound = false;
  room.turnsTakenInRound = 0;

  active.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
  });

  room.discardPile.push(room.deck.pop());
  room.currentTurnIdx = room.dealerIdx;

  broadcastState(roomId, `New round started! Dealer: ${room.players[room.dealerIdx].name}`);
}

function broadcastState(roomId, message = '') {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActivePlayers(room);
  const currentTurnPlayer = room.players[room.currentTurnIdx] || room.players[0];
  const minKnockScore = active.length === 2 ? 25 : 21;
  const roundHasPassed = room.turnsTakenInRound >= active.length;
  const totalGamePot = active.reduce((sum, p) => sum + (p.matchWager || 0), 0);

  room.players.forEach(p => {
    if (p.isBot) return;

    const isCurrent = currentTurnPlayer && currentTurnPlayer.id === p.id && !room.isResolvingRound && !p.isSpectator;
    const score = p.isSpectator ? 0 : calculateScore(p.hand);
    const canKnock = isCurrent && !room.knockerId && score >= minKnockScore && !room.drawnCard;

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
      allTableMembers: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        isOnline: true,
        isSpectator: Boolean(pl.isSpectator),
        lives: pl.lives
      })),
      hand: p.hand || [],
      score: score,
      minKnockScore: minKnockScore,
      roundHasPassed: roundHasPassed,
      topDiscard: room.discardPile && room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null,
      firstCardPickedUp: null,
      deckCount: room.deck ? room.deck.length : 52,
      isMyTurn: isCurrent,
      hasDrawn: Boolean(room.drawnCard),
      canKnock: canKnock,
      isSpectator: Boolean(p.isSpectator),
      manualSpectator: Boolean(p.manualSpectator),
      gameStarted: room.gameStarted,
      knocker: null,
      isReady: Boolean(p.isReady),
      activePlayersCount: getNonSpectatorCount(room),
      botCount: room.players.filter(pl => pl.isBot).length,
      maxActivePlayers: MAX_ACTIVE_PLAYERS,
      totalPot: totalGamePot,
      sideBetActionTotal: 0,
      activeSideBets: [],
      personalLedger: [],
      netOverallBalance: 0,
      netSideBetBalance: 0,
      message: message
    });
  });

  broadcastRoomList();
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
    const room = rooms[roomId];
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        broadcastState(roomId, `A player left.`);
      }
    }
    broadcastRoomList();
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

    room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
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
