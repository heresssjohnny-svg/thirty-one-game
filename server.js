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

  // 3 of a kind = 30.5 pts
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

const rooms = {};

function getActivePlayers(room) {
  return room.players.filter(p => p.lives > 0);
}

function advanceTurnIndex(room) {
  const total = room.players.length;
  if (total === 0) return;

  for (let step = 1; step <= total; step++) {
    const nextIdx = (room.currentTurnIdx + step) % total;
    if (room.players[nextIdx].lives > 0) {
      room.currentTurnIdx = nextIdx;
      return;
    }
  }
}

function getPrevActivePlayer(room, currentIdx) {
  const total = room.players.length;
  for (let step = 1; step <= total; step++) {
    const prevIdx = (currentIdx - step + total) % total;
    if (room.players[prevIdx].lives > 0) {
      return room.players[prevIdx];
    }
  }
  return null;
}

function startNewRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActivePlayers(room);
  if (active.length <= 1) {
    const winnerName = active[0] ? active[0].name : 'Nobody';
    io.to(roomId).emit('bigAnnouncement', {
      title: '🏆 GAME OVER 🏆',
      message: `${winnerName} WINS THE GAME!`,
      duration: 8000
    });
    room.gameStarted = false;
    return;
  }

  room.deck = createDeck();
  room.discardPile = [];
  room.knockerId = null;
  room.turnsLeftAfterKnock = null;
  room.drawnCard = null;
  room.isResolvingRound = false;
  room.turnsTakenInRound = 0; // Tracks turns completed so 1 full round must pass before knocking

  active.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
    p.takenFromPrev = [];
  });

  room.discardPile.push(room.deck.pop());

  // Move dealer clockwise
  for (let i = 1; i <= room.players.length; i++) {
    const nextD = (room.dealerIdx + i) % room.players.length;
    if (room.players[nextD].lives > 0) {
      room.dealerIdx = nextD;
      break;
    }
  }

  room.currentTurnIdx = room.dealerIdx;
  advanceTurnIndex(room);

  broadcastState(roomId, `New round! Dealer: ${room.players[room.dealerIdx].name}.`);
  triggerBotTurnIfNeeded(roomId);
}

function broadcastState(roomId, message = '') {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActivePlayers(room);
  const currentTurnPlayer = room.players[room.currentTurnIdx];
  const minKnockScore = active.length === 2 ? 25 : 21;
  const roundHasPassed = room.turnsTakenInRound >= active.length;

  room.players.forEach(p => {
    if (p.isBot) return;

    const isCurrent = currentTurnPlayer && currentTurnPlayer.id === p.id && !room.isResolvingRound;
    const score = calculateScore(p.hand);
    const canKnock = isCurrent && !room.knockerId && roundHasPassed && score >= minKnockScore && !room.drawnCard;

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
      minKnockScore: minKnockScore,
      roundHasPassed: roundHasPassed,
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
  if (!room || room.isResolvingRound) return;
  room.isResolvingRound = true;

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

  let losersText = '';
  if (knocker && lowestPlayers.some(p => p.id === knocker.id)) {
    knocker.lives -= 1;
    losersText = `${knocker.name} (Knocked & Tied/Lost)`;
  } else {
    lowestPlayers.forEach(p => { p.lives -= 1; });
    losersText = lowestPlayers.map(p => p.name).join(', ');
  }

  // Announce Loser(s) in Big Letters in Center of Screen
  io.to(roomId).emit('bigAnnouncement', {
    title: '💀 ROUND OVER 💀',
    message: `LOSER: ${losersText}`,
    subtext: `Lowest Score: ${minScore}`,
    duration: 4000
  });

  broadcastState(roomId, `Showdown finished! Loser: ${losersText}`);
  setTimeout(() => startNewRound(roomId), 4200);
}

function triggerBotTurnIfNeeded(roomId) {
  const room = rooms[roomId];
  if (!room || !room.gameStarted || room.isResolvingRound) return;

  const current = room.players[room.currentTurnIdx];
  if (!current || !current.isBot || current.lives <= 0) return;

  setTimeout(() => {
    if (!rooms[roomId] || room.isResolvingRound) return;

    const activeCount = getActivePlayers(room).length;
    const minKnockScore = activeCount === 2 ? 25 : 21;
    const roundHasPassed = room.turnsTakenInRound >= activeCount;
    const score = calculateScore(current.hand);

    // 1. Bot Knock Check (Only if round 1 has completed)
    if (!room.knockerId && roundHasPassed && score >= Math.max(minKnockScore, 26)) {
      room.knockerId = current.id;
      room.turnsLeftAfterKnock = activeCount - 1;
      advanceTurnIndex(room);
      broadcastState(roomId, `🔔 Bot ${current.name} KNOCKED with ${score} pts! Turn passes.`);
      triggerBotTurnIfNeeded(roomId);
      return;
    }

    // 2. Bot Draw Decision
    const topDiscard = room.discardPile[room.discardPile.length - 1];
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

    // 3. Bot Discard
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

    // Check if Bot reached 31
    if (calculateScore(current.hand) === 31) {
      room.isResolvingRound = true;
      const prevPlayer = getPrevActivePlayer(room, room.currentTurnIdx);
      const hasAce = current.takenFromPrev.some(c => c.rank === 'A');
      const hasTen = current.takenFromPrev.some(c => c.value === 10);

      if (hasAce && hasTen && prevPlayer) {
        prevPlayer.lives = 0;
        io.to(roomId).emit('bigAnnouncement', {
          title: '⚡ 31 HIT! ⚡',
          message: `LOSER: ${prevPlayer.name} LOST BOTH LIVES!`,
          subtext: `Fed an Ace and 10 to ${current.name}`,
          duration: 4500
        });
      } else {
        const losers = [];
        getActivePlayers(room).forEach(p => {
          if (p.id !== current.id) {
            p.lives -= 1;
            losers.push(p.name);
          }
        });
        io.to(roomId).emit('bigAnnouncement', {
          title: `⚡ ${current.name} HIT 31! ⚡`,
          message: `LOSERS: ${losers.join(', ')}`,
          subtext: 'Everyone else lost 1 life',
          duration: 4500
        });
      }
      setTimeout(() => startNewRound(roomId), 4500);
      return;
    }

    // Process countdown turns remaining after a knock
    if (room.knockerId) {
      room.turnsLeftAfterKnock -= 1;
      if (room.turnsLeftAfterKnock <= 0) {
        resolveShowdown(roomId);
        return;
      }
    }

    advanceTurnIndex(room);
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
        drawnCard: null,
        isResolvingRound: false,
        turnsTakenInRound: 0
      };
    }
    const room = rooms[roomId];

    const existingPlayer = room.players.find(p => p.name === playerName);
    if (existingPlayer) {
      existingPlayer.id = socket.id;
      broadcastState(roomId, `${playerName} reconnected.`);
      return;
    }

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

    broadcastState(roomId, `${playerName} joined the room.`);
  });

  socket.on('addBot', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return;
    if (room.players.length >= 6) return socket.emit('errorMsg', 'Max 6 players.');

    const botCount = room.players.filter(p => p.isBot).length + 1;
    room.players.push({
      id: `bot_${Date.now()}_${Math.random()}`,
      name: `Bot ${botCount}`,
      lives: 2,
      hand: [],
      takenFromPrev: [],
      isBot: true
    });

    broadcastState(roomId, `Bot ${botCount} joined.`);
  });

  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) {
      return socket.emit('errorMsg', 'Need at least 2 players or bots.');
    }
    room.gameStarted = true;
    startNewRound(roomId);
  });

  socket.on('knock', (roomId) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.knockerId || room.isResolvingRound) return;

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
      advanceTurnIndex(room);
      broadcastState(roomId, `🔔 ${player.name} KNOCKED with ${score} pts! Final turn for all other players.`);
      triggerBotTurnIfNeeded(roomId);
    }
  });

  socket.on('drawCard', ({ roomId, source }) => {
    const room = rooms[roomId];
    const player = room?.players[room.currentTurnIdx];
    if (!room || !player || player.id !== socket.id || room.drawnCard || room.isResolvingRound) return;

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
    if (!room || !player || player.id !== socket.id || !room.drawnCard || room.isResolvingRound) return;

    const [discarded] = player.hand.splice(cardIndex, 1);
    room.discardPile.push(discarded);
    room.drawnCard = null;
    room.turnsTakenInRound += 1;

    // Check for 31
    if (calculateScore(player.hand) === 31) {
      room.isResolvingRound = true;
      const prevPlayer = getPrevActivePlayer(room, room.currentTurnIdx);
      const hasAce = player.takenFromPrev.some(c => c.rank === 'A');
      const hasTen = player.takenFromPrev.some(c => c.value === 10);

      if (hasAce && hasTen && prevPlayer) {
        prevPlayer.lives = 0;
        io.to(roomId).emit('bigAnnouncement', {
          title: '⚡ 31 HIT! ⚡',
          message: `LOSER: ${prevPlayer.name} LOST BOTH LIVES!`,
          subtext: `Fed an Ace and 10 to ${player.name}`,
          duration: 4500
        });
      } else {
        const losers = [];
        getActivePlayers(room).forEach(p => {
          if (p.id !== player.id) {
            p.lives -= 1;
            losers.push(p.name);
          }
        });
        io.to(roomId).emit('bigAnnouncement', {
          title: `⚡ ${player.name} HIT 31! ⚡`,
          message: `LOSERS: ${losers.join(', ')}`,
          subtext: 'Everyone else lost 1 life',
          duration: 4500
        });
      }
      setTimeout(() => startNewRound(roomId), 4500);
      return;
    }

    // Countdown remaining turns after a knock
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
    for (const [roomId, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const leaving = room.players[idx];

        if (!room.gameStarted) {
          room.players.splice(idx, 1);
        } else {
          leaving.lives = 0;
          if (room.currentTurnIdx === idx) {
            advanceTurnIndex(room);
            triggerBotTurnIfNeeded(roomId);
          }
        }

        if (getActivePlayers(room).length === 0) {
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
  console.log(`Server online on port ${PORT}`);
});
