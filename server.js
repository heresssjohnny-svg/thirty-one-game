const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve static files from root and public
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
  res.status(404).send('Could not locate index.html. Ensure it exists in your repository.');
});

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 10, 'Q': 10, 'K': 10, 'A': 11
};

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
  const totals = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
  for (const c of hand) {
    totals[c.suit] += c.value;
  }
  return Math.max(...Object.values(totals));
}

const rooms = {};

function getActivePlayers(room) {
  return room.players.filter(p => p.lives > 0);
}

function getPrevActivePlayer(room, currentIdx) {
  let idx = (currentIdx - 1 + room.players.length) % room.players.length;
  while (room.players[idx].lives <= 0) {
    idx = (idx - 1 + room.players.length) % room.players.length;
  }
  return room.players[idx];
}

function startNewRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const active = getActivePlayers(room);

  if (active.length <= 1) {
    io.to(roomId).emit('gameOver', { winner: active[0] ? active[0].name : 'Nobody' });
    return;
  }

  room.deck = createDeck();
  room.discardPile = [];
  room.knockerId = null;
  room.turnsLeftAfterKnock = null;
  room.drawnCard = null;

  active.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
    p.takenFromPrev = [];
  });

  room.discardPile.push(room.deck.pop());

  // Dealer moves clockwise among living players
  do {
    room.dealerIdx = (room.dealerIdx + 1) % room.players.length;
  } while (room.players[room.dealerIdx].lives <= 0);

  // Turn starts to the left of the dealer
  let startIdx = (room.dealerIdx + 1) % room.players.length;
  while (room.players[startIdx].lives <= 0) {
    startIdx = (startIdx + 1) % room.players.length;
  }
  room.currentTurnIdx = startIdx;

  broadcastState(roomId, `New round began! Dealer is ${room.players[room.dealerIdx].name}.`);
  triggerBotTurnIfNeeded(roomId);
}

function broadcastState(roomId, message = '') {
  const room = rooms[roomId];
  if (!room) return;

  const currentTurnPlayer = room.players[room.currentTurnIdx];
  const activeCount = getActivePlayers(room).length;

  room.players.forEach(p => {
    if (p.isBot) return; // Bots don't need socket messages

    const isCurrent = currentTurnPlayer && currentTurnPlayer.id === p.id;
    const score = calculateScore(p.hand);
    const canKnock = isCurrent && !room.knockerId && activeCount > 2 && score >= 21 && !room.drawnCard;

    io.to(p.id).emit('gameState', {
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        lives: pl.lives,
        cardCount: pl.hand.length,
        isDealer: room.players[room.dealerIdx]?.id === pl.id,
        isTurn: currentTurnPlayer?.id === pl.id,
        isBot: Boolean(pl.isBot)
      })),
      hand: p.hand,
      score: score,
      topDiscard: room.discardPile[room.discardPile.length - 1],
      isMyTurn: isCurrent,
      hasDrawn: Boolean(room.drawnCard),
      canKnock: canKnock,
      gameStarted: room.gameStarted,
      knocker: room.knockerId ? room.players.find(pl => pl.id === room.knockerId)?.name : null,
      message: message
    });
  });
}

function resolveShowdown(roomId) {
  const room = rooms[roomId];
  const active = getActivePlayers(room);
  let minScore = 32;
  const scores = {};

  active.forEach(p => {
    const sc = calculateScore(p.hand);
    scores[p.id] = sc;
    if (sc < minScore) minScore = sc;
  });

  const lowestPlayers = active.filter(p => scores[p.id] === minScore);
  const knocker = room.players.find(p => p.id === room.knockerId);

  let msg = `Showdown! Lowest score: ${minScore}. `;
  if (knocker && lowestPlayers.some(p => p.id === knocker.id)) {
    knocker.lives -= 1;
    msg += `Knocker ${knocker.name} failed to beat everyone and lost a life!`;
  } else {
    lowestPlayers.forEach(p => { p.lives -= 1; });
    msg += `${lowestPlayers.map(p => p.name).join(', ')} lost a life!`;
  }

  broadcastState(roomId, msg);
  setTimeout(() => startNewRound(roomId), 4000);
}

function triggerBotTurnIfNeeded(roomId) {
  const room = rooms[roomId];
  if (!room || !room.gameStarted) return;

  const current = room.players[room.currentTurnIdx];
  if (!current || !current.isBot || current.lives <= 0) return;

  setTimeout(() => {
    // 1. Bot Knock Check
    const activeCount = getActivePlayers(room).length;
    const score = calculateScore(current.hand);
    if (!room.knockerId && activeCount > 2 && score >= 27) {
      room.knockerId = current.id;
      room.turnsLeftAfterKnock = activeCount - 1;
      broadcastState(roomId, `🔔 Bot ${current.name} KNOCKED!`);
    }

    // 2. Bot Draw Decision
    const topDiscard = room.discardPile[room.discardPile.length - 1];
    let takeDiscard = false;
    for (let i = 0; i < current.hand.length; i++) {
      const simHand = current.hand.slice(0, i).concat(current.hand.slice(i + 1), [topDiscard]);
      if (calculateScore(simHand) > score) {
        takeDiscard = true;
        break;
      }
    }

    let drawn;
    if (takeDiscard) {
      drawn = room.discardPile.pop();
      current.takenFromPrev.push(drawn);
    } else {
      if (room.deck.length === 0) {
        const top = room.discardPile.pop();
        room.deck = room.discardPile.sort(() => Math.random() - 0.5);
        room.discardPile = [top];
      }
      drawn = room.deck.pop();
    }
    current.hand.push(drawn);

    // 3. Bot Discard Decision (choose discard that maximizes remaining score)
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

    // Check if Bot reached 31
    if (calculateScore(current.hand) === 31) {
      const prevPlayer = getPrevActivePlayer(room, room.currentTurnIdx);
      const hasAce = current.takenFromPrev.some(c => c.rank === 'A');
      const hasTen = current.takenFromPrev.some(c => c.value === 10);

      if (hasAce && hasTen) {
        prevPlayer.lives = 0;
        broadcastState(roomId, `⚡ ${current.name} got 31! ${prevPlayer.name} fed an Ace & 10 and lost BOTH lives!`);
      } else {
        getActivePlayers(room).forEach(p => {
          if (p.id !== current.id) p.lives -= 1;
        });
        broadcastState(roomId, `⚡ ${current.name} got 31! All other players lose a life.`);
      }
      setTimeout(() => startNewRound(roomId), 4000);
      return;
    }

    // Check Knock turn progression
    if (room.knockerId) {
      room.turnsLeftAfterKnock -= 1;
      if (room.turnsLeftAfterKnock <= 0) {
        resolveShowdown(roomId);
        return;
      }
    }

    // Advance to next active player
    do {
      room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
    } while (room.players[room.currentTurnIdx].lives <= 0);

    broadcastState(roomId, `${current.name} discarded a card.`);
    triggerBotTurnIfNeeded(roomId);
  }, 1200);
}

io.on('connection', (socket) => {
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
        drawnCard: null
      };
    }
    const room = rooms[roomId];
    if (room.gameStarted) {
      socket.emit('errorMsg', 'Game is already in progress.');
      return;
    }

    room.players.push({
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      lives: 2,
      hand: [],
      takenFromPrev: [],
      isBot: false
    });

    broadcastState(roomId, `${playerName} entered the room.`);
  });

  socket.on('addBot', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;
    if (room.players.length >= 6) {
      socket.emit('errorMsg', 'Max 6 players allowed.');
      return;
    }

    const botCount = room.players.filter(p => p.isBot).length + 1;
    room.players.push({
      id: `bot_${Date.now()}_${Math.random()}`,
      name: `Bot ${botCount}`,
      lives: 2,
      hand: [],
      takenFromPrev: [],
      isBot: true
    });

    broadcastState(roomId, `Bot ${botCount} joined the room.`);
  });

  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) {
      socket.emit('errorMsg', 'Need at least 2 players (or add a Bot) to start.');
      return;
    }
    room.gameStarted = true;
    startNewRound(roomId);
  });

  socket.on('knock', (roomId) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.knockerId) return;

    if (getActivePlayers(room).length > 2 && calculateScore(player.hand) >= 21) {
      room.knockerId = player.id;
      room.turnsLeftAfterKnock = getActivePlayers(room).length - 1;
      broadcastState(roomId, `🔔 ${player.name} KNOCKED! Everyone gets one last turn.`);
    }
  });

  socket.on('drawCard', ({ roomId, source }) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.drawnCard) return;

    let drawn;
    if (source === 'discard') {
      drawn = room.discardPile.pop();
      player.takenFromPrev.push(drawn);
    } else {
      if (room.deck.length === 0) {
        const top = room.discardPile.pop();
        room.deck = room.discardPile.sort(() => Math.random() - 0.5);
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
    if (!room || !player || player.id !== socket.id || !room.drawnCard) return;

    const [discarded] = player.hand.splice(cardIndex, 1);
    room.discardPile.push(discarded);
    room.drawnCard = null;

    // Check for 31
    if (calculateScore(player.hand) === 31) {
      const prevPlayer = getPrevActivePlayer(room, room.currentTurnIdx);
      const hasAce = player.takenFromPrev.some(c => c.rank === 'A');
      const hasTen = player.takenFromPrev.some(c => c.value === 10);

      if (hasAce && hasTen) {
        prevPlayer.lives = 0;
        broadcastState(roomId, `⚡ ${player.name} got 31! ${prevPlayer.name} fed an Ace & 10 and lost BOTH lives!`);
      } else {
        getActivePlayers(room).forEach(p => {
          if (p.id !== player.id) p.lives -= 1;
        });
        broadcastState(roomId, `⚡ ${player.name} got 31! All other players lose a life.`);
      }
      setTimeout(() => startNewRound(roomId), 4000);
      return;
    }

    // Knocker turn progress
    if (room.knockerId) {
      room.turnsLeftAfterKnock -= 1;
      if (room.turnsLeftAfterKnock <= 0) {
        resolveShowdown(roomId);
        return;
      }
    }

    // Advance turn
    do {
      room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.length;
    } while (room.players[room.currentTurnIdx].lives <= 0);

    broadcastState(roomId, `${player.name} discarded a card.`);
    triggerBotTurnIfNeeded(roomId);
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const [leaving] = room.players.splice(idx, 1);
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          broadcastState(roomId, `${leaving.name} disconnected.`);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
