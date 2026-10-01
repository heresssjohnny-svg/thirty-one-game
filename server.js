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
  if (eligible.length < 1) return false;
  return eligible.every(p => p.isReady || p.isBot);
}

function broadcastRoomList() {
  const roomList = Object.entries(rooms).map(([id, r]) => {
    const activeCount = r.players.filter(p => !p.isSpectator).length;
    const spectatorCount = r.players.filter(p => p.isSpectator).length;
    const totalPot = activeCount * 5;
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

function broadcastState(roomId, message = '') {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActivePlayers(room);
  const currentTurnPlayer = room.players[room.currentTurnIdx] || room.players[0];
  const totalGamePot = active.reduce((sum, p) => sum + (p.matchWager || 0), 0);

  room.players.forEach(p => {
    if (p.isBot) return;

    io.to(p.id).emit('gameState', {
      myWager: p.matchWager || 0,
      configuredLives: room.configuredLives || 2,
      anyPlayerEliminated: false,
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        lives: pl.lives,
        cardCount: pl.hand ? pl.hand.length : 0,
        isDealer: false,
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
      score: calculateScore(p.hand),
      minKnockScore: 21,
      roundHasPassed: true,
      topDiscard: room.discardPile && room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null,
      firstCardPickedUp: null,
      deckCount: room.deck ? room.deck.length : 52,
      isMyTurn: currentTurnPlayer?.id === p.id && room.gameStarted,
      hasDrawn: false,
      canKnock: false,
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
        configuredLives: 2
      };
    }
    const room = rooms[roomId];
    let safeName = playerName ? playerName.trim() : `Player ${room.players.length + 1}`;

    const existing = room.players.find(p => p.name === safeName || (deviceId && p.deviceId === deviceId));
    if (existing) {
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
        isReady: false,
        matchWager: 0,
        joinOrder: playerJoinCounter
      });
    }

    broadcastState(roomId, `${safeName} joined the room.`);
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
    if (!player) return;

    player.isReady = !player.isReady;
    broadcastState(roomId, `${player.name} is ${player.isReady ? 'READY' : 'NOT READY'}`);
  });

  socket.on('addBot', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;

    if (room.players.length >= MAX_ACTIVE_PLAYERS) {
      return socket.emit('errorMsg', 'Max 6 players allowed.');
    }

    playerJoinCounter++;
    const botCount = room.players.filter(p => p.isBot).length + 1;
    room.players.push({
      id: `bot_${Date.now()}_${Math.random()}`,
      name: `Bot ${botCount}`,
      lives: room.configuredLives || 2,
      hand: [],
      isBot: true,
      isSpectator: false,
      isReady: true,
      matchWager: 5,
      joinOrder: playerJoinCounter
    });

    broadcastState(roomId, `Bot ${botCount} added.`);
  });

  socket.on('removeBot', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;

    const lastBotIdx = room.players.map(p => p.isBot).lastIndexOf(true);
    if (lastBotIdx !== -1) {
      room.players.splice(lastBotIdx, 1);
      broadcastState(roomId, `Bot removed.`);
    }
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        broadcastState(roomId, `A player disconnected.`);
      }
    }
    broadcastRoomList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server online on port ${PORT}`);
});
