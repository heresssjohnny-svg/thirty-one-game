// server/game/lobbyManager.js - PART 1 OF 2
const WebSocket = require('ws');
const { createDeck, calculateScore, calculateBestFourCardScore } = require('./deck');
const { recordDebt, resolveFirstToLoseBets, resolveWinSideBets } = require('./ledger');
const { executeBotTurn, syncBotReadiness } = require('./bot');
const config = require('../config');

// Safe Database loader for Lifetime Ledger sync
let db = null;
for (const p of ['../db', '../../db', './db', './server/db']) {
    try { db = require(p); break; } catch (e) {}
}

const lobbies = {};

function getLobbies() {
    return lobbies;
}

function getActiveParticipants(lobby) {
    return lobby.players.filter(p => !p.eliminated);
}

function findOpenSeat(lobby) {
    const occ = lobby.players.map(p => p.seat);
    for (let i = 0; i < 6; i++) {
        if (!occ.includes(i)) return i;
    }
    return 0;
}

function touchLobbyActivity(lobby, broadcastLobbyList) {
    if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
    lobby.inactivityTimer = setTimeout(() => closeInactiveLobby(lobby.code, broadcastLobbyList), config.INACTIVITY_TIMEOUT_MS);
}

function closeInactiveLobby(code, broadcastLobbyList) {
    const lobby = lobbies[code];
    if (!lobby) return;

    const hasActiveHumanSocket = lobby.players.some(p => !p.isBot && p.id && p.id.readyState === WebSocket.OPEN);
    if (hasActiveHumanSocket) return;

    const closePayload = JSON.stringify({ type: 'ERROR', message: 'Lobby closed due to inactivity.' });
    lobby.players.forEach(p => {
        if (p.id?.readyState === WebSocket.OPEN) {
            p.id.send(closePayload);
            p.id.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket?.readyState === WebSocket.OPEN) {
            s.idSocket.send(closePayload);
            s.idSocket.send(JSON.stringify({ type: 'LEFT_LOBBY' }));
        }
    });
    delete lobbies[code];
    if (broadcastLobbyList) broadcastLobbyList();
}

function getPublicLobbiesList() {
    return Object.values(lobbies).filter(l => !l.isPrivate).map(l => ({
        code: l.code,
        name: l.name,
        host: l.host,
        count: l.players.length,
        playerCount: l.players.length,
        maxPlayers: 6,
        state: l.gameState,
        gameState: l.gameState
    }));
}

function clearRoundOverTimer(lobby) {
    if (lobby && lobby.roundOverAutoTimer) {
        clearTimeout(lobby.roundOverAutoTimer);
        lobby.roundOverAutoTimer = null;
    }
}

function establishDealer(lobby) {
    if (lobby.lastGameWinner) {
        const winIdx = lobby.players.findIndex(p => p.username === lobby.lastGameWinner);
        if (winIdx !== -1) {
            lobby.dealerIndex = winIdx;
            return;
        }
    }
    if (lobby.dealerIndex >= lobby.players.length || lobby.dealerIndex < 0) {
        lobby.dealerIndex = 0;
    }
}

function getWinningSuitFor31(cards) {
    const suits = ['♠', '♥', '♦', '♣'];
    for (const s of suits) {
        const suitCards = cards.filter(c => c.suit === s);
        const suitScore = suitCards.reduce((sum, c) => sum + (c.points !== undefined ? c.points : 0), 0);
        if (suitScore >= 31) return s;
    }
    const suitCounts = {};
    cards.forEach(c => suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1);
    return Object.keys(suitCounts).reduce((a, b) => suitCounts[a] > suitCounts[b] ? a : b, cards[0]?.suit || '♠');
}

function getFeeder21OutOf31(lobby, winnerPlayer, winningSuit) {
    if (!lobby.fedCardsHistory || !lobby.fedCardsHistory[winnerPlayer.username]) {
        return null;
    }

    const recipientHistory = lobby.fedCardsHistory[winnerPlayer.username];

    for (const donorName in recipientHistory) {
        if (donorName.toLowerCase() === winnerPlayer.username.toLowerCase()) continue;

        const cardsFromDonor = recipientHistory[donorName] || [];
        const matchingCards = cardsFromDonor.filter(fedCard =>
            fedCard.suit === winningSuit &&
            winnerPlayer.cards.some(c => c.val === fedCard.val && c.suit === fedCard.suit)
        );

        const hasAce = matchingCards.some(c => c.val === 'A');
        const hasFaceOrTen = matchingCards.some(c => ['10', 'J', 'Q', 'K'].includes(c.val));

        if (hasAce && hasFaceOrTen) {
            return lobby.players.find(p => p.username === donorName && !p.eliminated) || null;
        }
    }

    return null;
}

// -------------------------------------------------------------
// USER ID RESOLUTION & INSTANT LIFETIME LEDGER SYNC
// -------------------------------------------------------------
function resolveUserId(lobby, username) {
    if (!username) return null;
    const p = lobby.players.find(pl => pl.username.toLowerCase() === username.toLowerCase());
    if (p && p.id && p.id.user && !p.id.user.isGuest) {
        return p.id.user.userId;
    }
    const s = lobby.spectators.find(sp => sp.username.toLowerCase() === username.toLowerCase());
    if (s && s.idSocket && s.idSocket.user && !s.idSocket.user.isGuest) {
        return s.idSocket.user.userId;
    }
    if (db && typeof db.findUserByUsername === 'function') {
        const row = db.findUserByUsername(username);
        if (row && row.id && !row.id.startsWith('gst_')) {
            return row.id;
        }
    }
    return null;
}

function recordSessionAndLifetimeDebt(lobby, ledger, debtorUsername, creditorUsername, amount) {
    recordDebt(ledger, debtorUsername, creditorUsername, amount);

    if (db && typeof db.recordLifetimeDebt === 'function') {
        const debtorId = resolveUserId(lobby, debtorUsername);
        const creditorId = resolveUserId(lobby, creditorUsername);

        if (debtorId && creditorId && debtorId !== creditorId) {
            db.recordLifetimeDebt(debtorId, creditorId, amount);

            const participants = [...lobby.players.map(pl => pl.id), ...lobby.spectators.map(sp => sp.idSocket)];
            participants.forEach(ws => {
                if (ws && ws.readyState === WebSocket.OPEN && ws.user && (ws.user.userId === debtorId || ws.user.userId === creditorId)) {
                    try {
                        const balances = db.getLifetimeBalances(ws.user.userId);
                        ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances }));
                    } catch (e) {}
                }
            });
        }
    }
}

function getSanitizedLobby(lobby, wsOrId) {
    const activeParts = getActiveParticipants(lobby);
    const allParticipants = [...lobby.players];
    const requestingPlayer = lobby.players.find(p => p.id === wsOrId);
    const requestingSpectator = lobby.spectators.find(s => s.idSocket === wsOrId);
    const myUsername = requestingPlayer ? requestingPlayer.username : (requestingSpectator?.username || null);

    let sortedParticipants = [...allParticipants];
    if (myUsername) {
        const idx = sortedParticipants.findIndex(p => p.username === myUsername);
        if (idx !== -1) sortedParticipants = sortedParticipants.slice(idx).concat(sortedParticipants.slice(0, idx));
    }
    sortedParticipants.forEach((p, i) => { p.seat = i; });

    const myUnrespondedBets = (lobby.pendingBets || []).filter(b => b.target === myUsername && !b.delivered?.[myUsername]);
    myUnrespondedBets.forEach(b => {
        if (!b.delivered) b.delivered = {};
        b.delivered[myUsername] = true;
    });

    let myFedReminder = null;
    if (myUsername && lobby.fedCardReminders?.[myUsername] && lobby.gameState !== 'roundOver' && lobby.gameState !== 'tournamentEnd') {
        const rem = lobby.fedCardReminders[myUsername];
        const targetPlayer = lobby.players.find(p => p.username === rem.target);
        if (targetPlayer?.cards?.some(c => c.val === rem.card.val && c.suit === rem.card.suit)) {
            myFedReminder = rem;
        } else {
            delete lobby.fedCardReminders[myUsername];
        }
    }

    let elapsedSeconds = 0;
    if (lobby.isPlaying && lobby.songStartedAt) {
        elapsedSeconds = Math.max(0, Math.floor((Date.now() - lobby.songStartedAt) / 1000));
    } else {
        elapsedSeconds = lobby.songPausedAtOffset || 0;
    }

    const isRoundOver = lobby.gameState === 'roundOver' || lobby.gameState === 'tournamentEnd';
    const activeUsername = myUsername?.toLowerCase();

    return {
        code: lobby.code,
        name: lobby.name,
        host: lobby.host,
        gameState: lobby.gameState,
        defaultLives: lobby.defaultLives || 2,
        deckCount: lobby.deck ? lobby.deck.length : 0,
        turnIndex: lobby.turnIndex,
        dealerIndex: lobby.dealerIndex,
        currentTurnUser: allParticipants[lobby.turnIndex]?.username || '',
        phaseMessage: lobby.phaseMessage,
        canKnock: lobby.turnsTakenThisRound >= activeParts.length,
        potTotal: allParticipants.reduce((sum, p) => sum + (p.wager || 5), 0),
        sidePotTotal: (lobby.activeBets || []).reduce((sum, b) => sum + (b.wagerAmt || 0), 0),
        lastGameWinner: lobby.lastGameWinner || null,
        tournamentWinner: lobby.tournamentWinner || null,
        hit31Player: lobby.hit31Player || null,
        myFedCardReminder: myFedReminder,
        sideBetLedger: lobby.sideBetLedger || {},
        mainGameLedger: lobby.mainGameLedger || {},
        botBetLedger: lobby.botBetLedger || {},
        pendingBetsForMe: myUnrespondedBets,
        globalProposals: lobby.globalProposals || [],
        activeBets: lobby.activeBets || [],
        pendingBets: lobby.pendingBets || [],
        activeParticipantsCount: activeParts.length,
        lastDiscardPickup: lobby.lastDiscardPickup || null,
        tiedParticipantsList: lobby.tiedParticipantsList || [],
        drawPool: (lobby.drawPool || []).map((c, i) => ({ index: i, chosenBy: c.chosenBy })),
        drawResults: lobby.drawResults || {},
        discardTop: lobby.discardPile ? (lobby.discardPile[lobby.discardPile.length - 1] || null) : null,
        knockedBy: lobby.knockedBy || null,
        chatHistory: lobby.chatHistory || [],
        playlist: lobby.playlist || [],
        currentSongIndex: lobby.currentSongIndex || 0,
        isPlaying: !!lobby.isPlaying,
        currentSongElapsedSeconds: elapsedSeconds,
        livekitHost: config.LIVEKIT_HOST,
        livesVote: lobby.livesVote || null,
        players: lobby.players.map((p, idx) => {
            const isMe = (p.id === wsOrId);
            const isPeekingAllowed = activeUsername && p.peekAllowed?.[activeUsername];
            const revealCards = isMe || isRoundOver || isPeekingAllowed;

            return {
                username: p.username,
                isMe: isMe,
                lives: Math.max(0, p.lives),
                wager: p.wager || 5,
                cardCount: p.cards ? p.cards.length : 0,
                ready: p.ready,
                seat: p.seat !== undefined ? p.seat : idx,
                nextHandReady: p.nextHandReady,
                eliminated: p.eliminated,
                isBot: !!p.isBot,
                inVC: !!p.inVC,
                isMuted: p.isMuted !== undefined ? p.isMuted : true,
                peekIncoming: isMe ? p.peekRequests : {},
                peekAllowed: p.peekAllowed || {},
                cards: revealCards ? (p.cards || []) : (p.cards ? p.cards.map(() => ({ val: '?', suit: '?' })) : [])
            };
        }),
        spectators: lobby.spectators.map(s => ({
            username: s.username,
            inVC: !!s.inVC,
            isMuted: s.isMuted !== undefined ? s.isMuted : true
        }))
    };
}

function broadcastLobbyUpdate(code) {
    const lobby = lobbies[code];
    if (!lobby) return;

    lobby.players.forEach(p => {
        if (p.id?.readyState === WebSocket.OPEN) {
            const data = getSanitizedLobby(lobby, p.id);
            p.id.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: data }));
            p.id.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: data }));
        }
    });
    lobby.spectators.forEach(s => {
        if (s.idSocket?.readyState === WebSocket.OPEN) {
            const data = getSanitizedLobby(lobby, s.idSocket);
            s.idSocket.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', lobby: data }));
            s.idSocket.send(JSON.stringify({ type: 'LOBBY_UPDATE', lobby: data }));
        }
    });
}

function handleSetReady(lobby, username, isReady) {
    if (lobby.gameState !== 'lobby') return;
    const player = lobby.players.find(p => p.username.toLowerCase() === (username || '').toLowerCase());
    if (!player) return;

    player.ready = Boolean(isReady);
    syncBotReadiness(lobby);
    broadcastLobbyUpdate(lobby.code);

    const active = getActiveParticipants(lobby);
    if (active.length >= 2 && active.every(p => p.ready)) {
        lobby.players.forEach(p => { p.ready = false; });
        startDealerDrawPhase(lobby);
    }
}

function startDealerDrawPhase(lobby) {
    clearRoundOverTimer(lobby);
    const deck = createDeck();
    lobby.drawPool = deck.map((c, i) => ({ index: i, card: c, chosenBy: null }));
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};
    lobby.phaseMessage = "Picking for Dealer (Lowest card deals, Ace highest)";
    lobby.gameState = 'dealerDraw';
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;
    lobby.turnsTakenThisRound = 0;
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.players.forEach(p => {
        p.peekAllowed = {};
        p.peekRequests = {};
        if (!p.eliminated) p.nextHandReady = p.isBot;
    });
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function startRound(lobby) {
    clearRoundOverTimer(lobby);
    lobby.deck = createDeck();
    lobby.discardPile = [];
    lobby.drawPool = [];
    lobby.drawResults = {};
    lobby.drawOrderSequence = [];
    lobby.tiedParticipantsList = [];
    lobby.pendingBotDraw = {};
    lobby.lastDiscardPickup = null;
    lobby.fedCardReminders = {};
    lobby.fedCardsHistory = {};
    lobby.knockedBy = null;
    lobby.tournamentWinner = null;
    lobby.hit31Player = null;
    lobby.gameState = 'playing';
    lobby.finalTurnsRemaining = 0;
    lobby.turnsTakenThisRound = 0;

    const activeParts = getActiveParticipants(lobby);
    if (activeParts.length <= 1) {
        awardTournamentWinner(lobby, activeParts[0]);
        return;
    }

    lobby.players.forEach(p => {
        p.peekAllowed = {};
        p.peekRequests = {};
    });

    establishDealer(lobby);

    const totalPlayers = lobby.players.length;
    const dealOrder = [];
    for (let i = 1; i <= totalPlayers; i++) {
        const idx = (lobby.dealerIndex + i) % totalPlayers;
        dealOrder.push(lobby.players[idx]);
    }

    const regularParticipants = dealOrder.filter(p => !p.eliminated && !p.isNewArrival);
    const newArrivals = dealOrder.filter(p => !p.eliminated && p.isNewArrival);
    const finalDealOrder = [...regularParticipants, ...newArrivals];

    finalDealOrder.forEach(p => {
        p.cards = [lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop()];
        p.nextHandReady = p.isBot;
        p.isNewArrival = false;
    });

    const firstDiscard = lobby.deck.pop();
    lobby.discardPile.push(firstDiscard);
    lobby.initialDealCard = { val: firstDiscard.val, suit: firstDiscard.suit };
    lobby.lastDiscardDonor = lobby.players[lobby.dealerIndex]?.username || null;

    lobby.turnIndex = (lobby.dealerIndex + 1) % lobby.players.length;
    while (lobby.players[lobby.turnIndex].eliminated) {
        lobby.turnIndex = (lobby.turnIndex + 1) % lobby.players.length;
    }

    lobby.phaseMessage = `Round started! Turn: ${lobby.players[lobby.turnIndex].username}`;
    broadcastLobbyUpdate(lobby.code);
    scheduleBotActions(lobby);
}

function advanceDealerToNextActive(lobby) {
    let nextDealer = (lobby.dealerIndex + 1) % lobby.players.length;
    let safety = 0;
    while (lobby.players[nextDealer].eliminated && safety < lobby.players.length) {
        nextDealer = (nextDealer + 1) % lobby.players.length;
        safety++;
    }
    lobby.dealerIndex = nextDealer;
}

function handlePoolCardSelection(lobby, username, cardIndex) {
    if (lobby.gameState === 'tieBreaker' && !lobby.tiedParticipantsList.includes(username)) return;
    if (lobby.drawResults && lobby.drawResults[username]) return;

    if (lobby.drawPool[cardIndex] && lobby.drawPool[cardIndex].chosenBy === null) {
        lobby.drawPool[cardIndex].chosenBy = username;
        const card = lobby.drawPool[cardIndex].card;
        lobby.drawResults[username] = card;
        if (!lobby.drawOrderSequence) lobby.drawOrderSequence = [];
        lobby.drawOrderSequence.push({ username, card });
        broadcastLobbyUpdate(lobby.code);

        const activeParts = getActiveParticipants(lobby);
        if (lobby.gameState === 'dealerDraw' && activeParts.every(p => lobby.drawResults[p.username])) {
            const entries = Object.entries(lobby.drawResults).map(([u, c]) => ({ username: u, card: c })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            lobby.dealerIndex = lobby.players.findIndex(p => p.username === entries[0].username);
            lobby.phaseMessage = `🎉 ${entries[0].username} drew lowest and is Dealer!`;
            broadcastLobbyUpdate(lobby.code);
            setTimeout(() => {
                if (lobbies[lobby.code]) startRound(lobbies[lobby.code]);
            }, 3000);
        } else if (lobby.gameState === 'tieBreaker' && lobby.tiedParticipantsList.every(u => lobby.drawResults[u])) {
            const entries = lobby.tiedParticipantsList.map(u => ({ username: u, card: lobby.drawResults[u] })).sort((a, b) => a.card.drawVal - b.card.drawVal);
            const lowestDrawVal = entries[0].card.drawVal;
            const tiedLowest = entries.filter(e => e.card.drawVal === lowestDrawVal);

            if (tiedLowest.length > 1) {
                lobby.tiedParticipantsList = tiedLowest.map(t => t.username);
                lobby.pendingBotDraw = {};
                lobby.phaseMessage = `⚠️ Tie on lowest card (${entries[0].card.val})! Drawing again in 3 seconds...`;
                broadcastLobbyUpdate(lobby.code);

                setTimeout(() => {
                    if (!lobbies[lobby.code] || lobbies[lobby.code].gameState !== 'tieBreaker') return;
                    const cur = lobbies[lobby.code];
                    const tieDeck = (cur.deck && cur.deck.length >= cur.tiedParticipantsList.length) ? cur.deck : createDeck();
                    cur.drawPool = tieDeck.map((c, i) => ({ index: i, card: c, chosenBy: null }));
                    cur.drawResults = {};
                    cur.drawOrderSequence = [];
                    cur.pendingBotDraw = {};
                    cur.phaseMessage = `Tie-Breaker Re-Draw: Pick a card!`;
                    broadcastLobbyUpdate(cur.code);
                    scheduleBotActions(cur);
                }, 3000);
                return;
            }

            const loser = lobby.players.find(p => p.username === entries[0].username);
            if (loser) {
                loser.lives = Math.max(0, loser.lives - 1);
                if (loser.lives <= 0 && !loser.eliminated) {
                    loser.eliminated = true;
                    resolveFirstToLoseBets(lobby, loser.username);
                    if (loser.id && typeof loser.id === 'object') {
                        lobby.spectators.push({ idSocket: loser.id, username: loser.username, inVC: loser.inVC, isMuted: loser.isMuted });
                    }
                }
            }
            lobby.phaseMessage = `${entries[0].username} drew lowest in tie-breaker!`;
            broadcastLobbyUpdate(lobby.code);

            setTimeout(() => {
                if (!lobbies[lobby.code]) return;
                const currentLobby = lobbies[lobby.code];
                if (getActiveParticipants(currentLobby).length <= 1) {
                    awardTournamentWinner(currentLobby, getActiveParticipants(currentLobby)[0]);
                } else {
                    advanceDealerToNextActive(currentLobby);
                    triggerRoundOver(currentLobby, `${entries[0].username} lost a life in tie-breaker!`);
                }
            }, 3000);
        } else {
            scheduleBotActions(lobby);
        }
    }
}
// F. CENTER TABLE & POTS RENDER
        const tableContainer = document.getElementById('table-oval-container');
        if (tableContainer) {
            // Update Pot
            const potDisplay = document.getElementById('pot-display');
            if (potDisplay) potDisplay.innerText = `$${lobby.potTotal || 0}`;

            // Update Deck
            const deckSlot = document.getElementById('deck-card-slot');
            if (deckSlot) {
                const label = deckSlot.querySelector('.card-deck-label');
                if (label) label.innerText = `DECK (${lobby.deckCount || 0})`;
            }

            // Update Discard
            const discardSlot = document.getElementById('discard-card-slot');
            if (discardSlot) {
                if (lobby.discardTop) {
                    discardSlot.innerHTML = window.formatCardHtml(lobby.discardTop, false);
                } else {
                    discardSlot.innerHTML = `
                        <div class="card-slot-placeholder">
                            <span>DISCARD</span>
                            <span class="sub">Empty</span>
                        </div>
                    `;
                }
            }

            // Update Seats (0-5)
            for (let i = 0; i < 6; i++) {
                const seatEl = document.getElementById(`seat-${i}`);
                if (!seatEl) continue;
                
                const p = (lobby.players || []).find(player => player.seat === i);
                if (p) {
                    const isCurrent = (p.username.toLowerCase() === (lobby.currentTurnUser || '').toLowerCase()) && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn');
                    const isDealer = (lobby.dealerIndex !== undefined && p.seat === lobby.dealerIndex) || (lobby.dealerName === p.username);
                    
                    if (isCurrent) seatEl.classList.add('current-turn');
                    else seatEl.classList.remove('current-turn');

                    const nameDisplay = seatEl.querySelector('.seat-name');
                    if (nameDisplay) {
                        nameDisplay.innerHTML = `<b>${p.username}</b>${p.isBot ? ' 🤖' : ''}${isDealer ? ' <span class="dealer-badge" style="background:#d97706; color:#fff; font-size:0.6rem; padding:1px 4px; border-radius:4px; margin-left:4px;">D</span>' : ''}`;
                    }
                    
                    const livesDisplay = seatEl.querySelector('.seat-lives');
                    if (livesDisplay) {
                        livesDisplay.innerText = `Lives: ${p.lives} | Wager: $${p.wager || 5}`;
                    }
                    
                    const statusDisplay = seatEl.querySelector('.seat-status');
                    if (statusDisplay) {
                        let statusText = p.eliminated ? 'OUT' : (p.ready && lobby.gameState === 'lobby' ? 'READY' : '');
                        statusDisplay.innerText = statusText;
                    }

                    const cardsContainer = seatEl.querySelector('.seat-cards');
                    if (cardsContainer) {
                        cardsContainer.innerHTML = (p.cards && p.cards.length > 0) ? p.cards.map(c => window.formatCardHtml(c, true)).join('') : '';
                    }
                    
                    seatEl.style.opacity = p.eliminated ? '0.5' : '1';
                    seatEl.onclick = () => window.tapSeat(p.username);
                } else {
                    seatEl.classList.remove('current-turn');
                    const nameDisplay = seatEl.querySelector('.seat-name');
                    if (nameDisplay) nameDisplay.innerText = 'Empty';
                    
                    const livesDisplay = seatEl.querySelector('.seat-lives');
                    if (livesDisplay) livesDisplay.innerText = '';
                    
                    const statusDisplay = seatEl.querySelector('.seat-status');
                    if (statusDisplay) statusDisplay.innerText = 'Open';
                    
                    const cardsContainer = seatEl.querySelector('.seat-cards');
                    if (cardsContainer) cardsContainer.innerHTML = '';
                    
                    seatEl.style.opacity = '0.6';
                    seatEl.onclick = null;
                }
            }
        }

        // G. LOCAL HAND RENDERING WITH AUTHENTIC PLAYING CARDS
        const handContainer = document.getElementById('my-cards-container');
        const myHandTitle = document.getElementById('my-hand-title');

        if (isSpectatorOnly) {
            if (handContainer) handContainer.innerHTML = '<div class="no-cards-msg">👀 Spectator Mode</div>';
            if (myHandTitle) myHandTitle.innerHTML = 'Spectating Table';
            const knockBtn = document.getElementById('knock-btn');
            if (knockBtn) knockBtn.style.display = 'none';
        } else if (me && me.cards && handContainer) {
            const currentScore = window.calculateLocalScore(me.cards);
            if (myHandTitle) myHandTitle.innerHTML = `My Hand (Score: <strong style="color: #d4af37;">${currentScore}</strong>)`;
            
            handContainer.innerHTML = me.cards.map((c, i) => {
                const cardHtml = window.formatCardHtml(c, false);
                return `<div class="my-card-wrapper" onclick="window.discardCard(${i})" style="cursor:pointer; transition: transform 0.15s ease;">${cardHtml}</div>`;
            }).join('');
            
            if (typeof window.updateKnockButtonState === 'function') {
                window.updateKnockButtonState(lobby, me, isMyTurnPlaying);
            }
        } else if (handContainer) {
            handContainer.innerHTML = '<div class="no-cards-msg">No active cards</div>';
            if (myHandTitle) myHandTitle.innerHTML = 'My Hand';
        }

        // H. SESSION LEDGER AUTO-SYNC
        const sessionLedgerModal = document.getElementById('session-ledger-modal');
        if (sessionLedgerModal && sessionLedgerModal.style.display === 'flex' && typeof window.renderSessionLedger === 'function') {
            window.renderSessionLedger(lobby);
        }
};

// -------------------------------------------------------------
// 5. IN-GAME ACTIONS & CARD INTERACTIONS
// -------------------------------------------------------------
window.drawCard = function(source) {
    if (window.clientState?.isSpectator) return;
    window.safePlaySound('card');
    window.safeVibrate(40);
    window.sendSocket({ type: source === 'deck' ? 'DRAW_DECK' : 'DRAW_DISCARD' });
};

window.drawFromDeck = function() { window.drawCard('deck'); };
window.drawFromDiscard = function() { window.drawCard('discard'); };

window.discardCard = function(cardIndex) {
    if (window.clientState?.isSpectator) return;
    window.safePlaySound('card');
    window.safeVibrate(30);
    window.sendSocket({
        type: 'DISCARD_CARD',
        index: cardIndex,
        cardIndex: cardIndex
    });
};

window.choosePoolCard = function(cardIndex) {
    const resolvedIndex = (typeof cardIndex === 'number') ? cardIndex : parseInt(cardIndex, 10);
    if (isNaN(resolvedIndex)) return;
    if (window.appGlobals.hasChosenPoolCard) return;

    window.appGlobals.hasChosenPoolCard = true;
    window.safePlaySound('card');
    window.safeVibrate(25);

    window.sendSocket({
        type: 'CHOOSE_POOL_CARD',
        cardIndex: resolvedIndex,
        index: resolvedIndex
    });

    setTimeout(() => {
        const snap = window.appGlobals?.latestLobbySnapshot;
        const myName = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
        if (snap && (snap.gameState === 'dealerDraw' || snap.gameState === 'tieBreaker') && !snap.drawResults?.[myName]) {
            window.appGlobals.hasChosenPoolCard = false;
        }
    }, 1200);
};

window.clickNextHand = function() {
    const btn = document.getElementById('next-hand-btn');
    if (btn) {
        btn.innerText = 'Waiting...';
        btn.disabled = true;
    }
    window.sendSocket({ type: 'NEXT_HAND_READY' });
    window.sendSocket({ type: 'NEXT_HAND' });
};

window.toggleReady = function() {
    const isReady = !(window.clientState?.isReady);
    if (window.clientState) window.clientState.isReady = isReady;
    const btn = document.getElementById('ready-btn');
    if (btn) btn.innerText = isReady ? 'Unready' : 'Ready Up';
    window.appGlobals.hasChosenPoolCard = false;
    window.sendSocket({ type: 'SET_READY', ready: isReady });
};

window.standUp = function() { window.sendSocket({ type: 'STAND_UP' }); };
window.sitDown = function() { window.sendSocket({ type: 'SIT_DOWN' }); };
window.addBot = function() { window.sendSocket({ type: 'ADD_BOT' }); };
window.removeBot = function() { window.sendSocket({ type: 'REMOVE_BOT' }); };
window.proposeEndGame = function() {
    if (confirm("Propose ending the game and returning to the lobby?")) {
        window.sendSocket({ type: 'END_GAME_PROPOSAL' });
    }
};
window.leaveLobby = function() {
    window.appGlobals.currentJoinedCode = null;
    localStorage.removeItem('blitz31_active_room');
    window.sendSocket({ type: 'LEAVE_LOBBY' });
    window.location.reload();
};

// -------------------------------------------------------------
// 6. KNOCK VALIDATION, AUDIO & VIBRATION
// -------------------------------------------------------------
window.knockRound = function() {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
    const me = window.appGlobals?.latestLobbySnapshot?.players?.find(p => p.username.toLowerCase() === activeUsername.toLowerCase());

    if (!me || !me.cards || me.cards.length !== 3) {
        window.showCenterNotification("You cannot knock after picking up a card!");
        return;
    }

    const currentScore = window.calculateLocalScore(me.cards);
    const activeCount = window.appGlobals?.latestLobbySnapshot?.activeParticipantsCount || 3;
    const threshold = activeCount > 2 ? 21 : 25;

    if (currentScore < threshold) {
        window.showCenterNotification(`Need at least ${threshold} points to knock!`);
        return;
    }

    if (currentScore <= 30) {
        const confirmKnock = confirm(`Knock Confirmation: Are you sure you want to knock with ${currentScore} points?`);
        if (!confirmKnock) return;
    }

    window.safePlaySound('knock');
    window.safeVibrate([180, 110, 180, 110, 180]);
    window.sendSocket({ type: 'KNOCK' });
};

window.updateKnockButtonState = function(lobby, me, isMyTurn) {
    const knockBtn = document.getElementById('knock-btn');
    if (!knockBtn) return;

    const activeCount = lobby.activeParticipantsCount || 3;
    const threshold = activeCount > 2 ? 21 : 25;
    const myScore = (me && me.cards) ? window.calculateLocalScore(me.cards) : 0;
    const turnsConditionMet = !!lobby.canKnock;
    const scoreConditionMet = myScore >= threshold;
    const hasNotDrawn = me && me.cards && me.cards.length === 3;

    if (lobby.knockedBy) {
        knockBtn.disabled = true;
        knockBtn.innerText = `${lobby.knockedBy} knocked!`;
        knockBtn.style.display = 'inline-block';
    } else if (!turnsConditionMet || !scoreConditionMet || !isMyTurn || !hasNotDrawn) {
        knockBtn.disabled = true;
        knockBtn.innerText = `Knock (${threshold}+)`;
        knockBtn.style.display = 'inline-block';
    } else {
        knockBtn.disabled = false;
        knockBtn.innerText = 'Knock!';
        knockBtn.style.display = 'inline-block';
    }
};

// -------------------------------------------------------------
// 7. SIDE BETS & DIALOGS
// -------------------------------------------------------------
window.tapSeat = function(targetUsername) {
    const activeUsername = (document.getElementById('username-input')?.value || window.clientState?.username || 'Player1').trim();
    if (window.appGlobals?.latestLobbySnapshot?.gameState === 'lobby') return;
    
    const activeCount = window.appGlobals?.latestLobbySnapshot?.activeParticipantsCount || 3;
    if (targetUsername.toLowerCase() === activeUsername.toLowerCase()) return;

    const modalTitle = document.getElementById('bet-modal-title');
    const modalBody = document.getElementById('bet-modal-body');

    if (activeCount >= 3) {
        if (modalTitle) modalTitle.innerText = `First to Lose Bet on ${targetUsername}`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:#94a3b8; margin-bottom:10px;">Select wager that ${targetUsername} is eliminated before you:</p>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="primary-btn" onclick="window.submitEliminationProposal('${targetUsername}', 5)">$5 Wager</button>
                    <button class="primary-btn" onclick="window.submitEliminationProposal('${targetUsername}', 10)">$10 Wager</button>
                    <button class="primary-btn" onclick="window.submitEliminationProposal('${targetUsername}', 20)">$20 Wager</button>
                </div>
            `;
        }
    } else {
        if (modalTitle) modalTitle.innerText = `Global Side Bet: I like ${targetUsername} to win!`;
        if (modalBody) {
            modalBody.innerHTML = `
                <p style="font-size:0.85rem; color:#94a3b8; margin-bottom:10px;">Select wager amount:</p>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="primary-btn" onclick="window.submitGlobalProposal('${targetUsername}', 5)">$5 Wager</button>
                    <button class="primary-btn" onclick="window.submitGlobalProposal('${targetUsername}', 10)">$10 Wager</button>
                    <button class="primary-btn" onclick="window.submitGlobalProposal('${targetUsername}', 20)">$20 Wager</button>
                </div>
            `;
        }
    }
    window.toggleModal('bet-modal');
};

window.submitEliminationProposal = function(target, wagerAmt) {
    window.sendSocket({ type: 'PROPOSE_ELIMINATION_BET', target, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`First to lose bet proposed to ${target}!`);
};

window.submitGlobalProposal = function(pickUser, wagerAmt) {
    window.sendSocket({ type: 'PROPOSE_GLOBAL_SIDE_BET', pickUser, wagerAmt });
    window.toggleModal('bet-modal');
    window.showCenterNotification(`Global bet offered on ${pickUser}!`);
};
