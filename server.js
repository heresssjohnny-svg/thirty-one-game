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

const rooms = {};

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
    
    let activeAssigned = 0;
    room.players.forEach(p => { 
      if (activeAssigned < MAX_ACTIVE_PLAYERS) {
        p.isSpectator = false;
        p.lives = 2;
        activeAssigned++;
      } else {
        p.isSpectator = true;
        p.lives = 0;
      }
      p.isReady = false; 
    });
    broadcastState(roomId, `Game over! Toggle Ready to start the next game.`);
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
    p.lastDrawnSource = null;

    if (dealer && dealer.id !== p.id) {
      p.fedCardsTracker[dealer.id] = [];
      p.hand.forEach(c => {
        if (c.rank === 'A' || c.value === 10) {
          p.fedCardsTracker[dealer.id].push(c);
        }
      });
    }
  });

  room.discardPile.push(room.deck.pop());

  room.currentTurnIdx = room.dealerIdx;
  advanceTurnIndex(room);

  broadcastState(roomId, `New round! Dealer: ${dealer?.name || 'Dealer'}.`);
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

    if (room.gameStarted && !p.isSpectator && p.lives > 0 && p.hand && p.hand.length < 3 && room.deck && room.deck.length > 0) {
      while (p.hand.length < 3 && room.deck.length > 0) {
        p.hand.push(room.deck.pop());
      }
    }

    const isCurrent = currentTurnPlayer && currentTurnPlayer.id === p.id && !room.isResolvingRound && !p.isSpectator;
    const score = p.isSpectator ? 0 : calculateScore(p.hand);
    const canKnock = isCurrent && !room.knockerId && roundHasPassed && score >= minKnockScore && !room.drawnCard;

    io.to(p.id).emit('gameState', {
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
        isInVoice: Boolean(pl.isInVoice)
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
      gameStarted: room.gameStarted,
      knocker: room.knockerId ? room.players.find(pl => pl.id === room.knockerId)?.name : null,
      isReady: Boolean(p.isReady),
      activePlayersCount: getNonSpectatorCount(room),
      maxActivePlayers: MAX_ACTIVE_PLAYERS,
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
  const revealedHands = getRevealedHands(room);

  if (knocker && lowestPlayers.some(p => p.id === knocker.id) && lowestPlayers.length === 1) {
    knocker.lives -= 1;
    const losersText = `${knocker.name} (Knocker lost alone)`;
    io.to(roomId).emit('bigAnnouncement', {
      title: '💀 ROUND OVER 💀',
      message: `LOSER: ${losersText}`,
      subtext: `Lowest Score: ${minScore}`,
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
        subtext: `Both players tied at ${minScore} points`,
        hands: revealedHands,
        duration: 6500
      });
      broadcastState(roomId, `Heads-up tie at ${minScore}! Re-dealing with no lives lost.`);
      setTimeout(() => startNewRound(roomId), 6500);
      return;
    }

    let eligibleDeck = [...room.deck];
    if (eligibleDeck.length < lowestPlayers.length) {
      const top = room.discardPile.pop();
      eligibleDeck = eligibleDeck.concat(room.discardPile.sort(() => Math.random() - 0.5));
      room.discardPile = [top];
    }

    let tiebreakReport = [];
    let cutLoser = null;
    let minCardVal = 99;

    lowestPlayers.forEach(p => {
      const drawnCard = eligibleDeck.pop() || { rank: '2', suit: '♠' };
      const cardRankVal = CUT_RANKS[drawnCard.rank];
      tiebreakReport.push(`${p.name}: ${drawnCard.rank}${drawnCard.suit}`);

      if (cardRankVal < minCardVal) {
        minCardVal = cardRankVal;
        cutLoser = { player: p, card: drawnCard };
      }
    });

    room.deck = eligibleDeck;
    cutLoser.player.lives -= 1;

    io.to(roomId).emit('bigAnnouncement', {
      title: '⚡ TIEBREAKER CUT! ⚡',
      message: `LOSER: ${cutLoser.player.name} (${cutLoser.card.rank}${cutLoser.card.suit})`,
      subtext: tiebreakReport.join('  |  '),
      hands: revealedHands,
      duration: 7500
    });

    broadcastState(roomId, `Tiebreaker Cut: ${cutLoser.player.name} drew lowest card (${cutLoser.card.rank}${cutLoser.card.suit}) and lost a life!`);
    setTimeout(() => startNewRound(roomId), 7500);
    return;
  }

  const singleLoser = lowestPlayers[0];
  singleLoser.lives -= 1;

  io.to(roomId).emit('bigAnnouncement', {
    title: '💀 ROUND OVER 💀',
    message: `LOSER: ${singleLoser.name}`,
    subtext: `Lowest Score: ${minScore}`,
    hands: revealedHands,
    duration: 6500
  });

  broadcastState(roomId, `Showdown finished! Loser: ${singleLoser.name}`);
  setTimeout(() => startNewRound(roomId), 6500);
}

function checkAndHandle31(room, player) {
  if (calculateScore(player.hand) !== 31) return false;

  room.isResolvingRound = true;
  let penalizedGiver = null;
  const revealedHands = getRevealedHands(room);

  if (player.lastDrawnSource === 'discard' && player.fedCardsTracker) {
    for (const [giverId, cards] of Object.entries(player.fedCardsTracker)) {
      const hasAce = cards.some(c => c.rank === 'A');
      const hasTen = cards.some(c => c.value === 10);
      if (hasAce && hasTen) {
        penalizedGiver = room.players.find(p => p.id === giverId && p.lives > 0);
        if (penalizedGiver) break;
      }
    }
  }

  if (penalizedGiver) {
    penalizedGiver.lives = 0;
    io.to(room.id).emit('bigAnnouncement', {
      title: '⚡ 31 HIT FROM DISCARD! ⚡',
      message: `LOSER: ${penalizedGiver.name} LOST BOTH LIVES!`,
      subtext: `Fed Ace & 10 to ${player.name} via discard!`,
      hands: revealedHands,
      duration: 6500
    });
  } else {
    const losers = [];
    getActivePlayers(room).forEach(p => {
      if (p.id !== player.id) {
        p.lives -= 1;
        losers.push(p.name);
      }
    });

    const drawDesc = player.lastDrawnSource === 'deck' ? 'Grabbed from Deck!' : 'Natural 31!';
    io.to(room.id).emit('bigAnnouncement', {
      title: `⚡ ${player.name} HIT 31! ⚡`,
      message: `ALL OTHER PLAYERS LOSE A LIFE!`,
      subtext: `${drawDesc} Losers: ${losers.join(', ')}`,
      hands: revealedHands,
      duration: 6500
    });
  }

  setTimeout(() => startNewRound(room.id), 6500);
  return true;
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

    if (!room.knockerId && roundHasPassed && score >= Math.max(minKnockScore, 26)) {
      room.knockerId = current.id;
      room.turnsLeftAfterKnock = activeCount - 1;

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
      current.lastDrawnSource = 'discard';
      const prevPlayer = getPrevActivePlayer(room, room.currentTurnIdx);
      if (prevPlayer) {
        if (!current.fedCardsTracker) current.fedCardsTracker = {};
        if (!current.fedCardsTracker[prevPlayer.id]) current.fedCardsTracker[prevPlayer.id] = [];
        current.fedCardsTracker[prevPlayer.id].push(drawn);
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

function handlePlayerExit(socketId) {
  for (const [roomId, room] of Object.entries(rooms)) {
    const idx = room.players.findIndex(p => p.id === socketId);
    if (idx !== -1) {
      const leaving = room.players[idx];

      io.to(roomId).emit('voiceUserLeft', { socketId: socketId });

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
        broadcastState(roomId, `${leaving.name} left the room.`);
      }
      break;
    }
  }
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
      isReady: false,
      isInVoice: false
    });

    let joinMsg = `${playerName} joined the room.`;
    if (roomIsFull && !room.gameStarted) {
      joinMsg = `👁️ Room active player limit (6) reached. ${playerName} joined as a spectator.`;
    } else if (room.gameStarted) {
      joinMsg = `👁️ ${playerName} joined as a spectator.`;
    }

    broadcastState(roomId, joinMsg);
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
      startNewRound(roomId);
    }
  });

  socket.on('leaveRoom', (roomId) => {
    socket.leave(roomId);
    handlePlayerExit(socket.id);
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
      isReady: true,
      isInVoice: false
    });

    broadcastState(roomId, `Bot ${botCount} joined.`);
    if (checkAllPlayersReady(room)) {
      room.gameStarted = true;
      startNewRound(roomId);
    }
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

      const prevPlayer = getPrevActivePlayer(room, room.currentTurnIdx);
      if (prevPlayer) {
        if (!player.fedCardsTracker) player.fedCardsTracker = {};
        if (!player.fedCardsTracker[prevPlayer.id]) player.fedCardsTracker[prevPlayer.id] = [];
        player.fedCardsTracker[prevPlayer.id].push(drawn);
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
    handlePlayerExit(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server online on port ${PORT}`);
});
