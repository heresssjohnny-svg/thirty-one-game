const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

const lobbies = {};

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

// WebSocket Keep-Alive to prevent mobile OS TCP teardowns
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

wss.on('close', () => clearInterval(heartbeatInterval));

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            let points = 10;
            let drawVal = parseInt(v) || (v === 'A' ? 14 : (v === 'K' ? 13 : (v === 'Q' ? 12 : 11)));
            if (v === 'A') points = 11;
            else if (['J', 'Q', 'K'].includes(v)) points = 10;
            else points = parseInt(v, 10);
            deck.push({ suit: s, val: v, points, drawVal });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function touchLobbyActivity(lobby) {
    if (lobby.inactivityTimer) clearTimeout(lobby.inactivityTimer);
    lobby.inactivityTimer = setTimeout(() => closeInactiveLobby(lobby.code), 20 * 60 * 1000);
}

function closeInactiveLobby(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let closePayload = JSON.stringify({ type: 'ERROR', message: 'Lobby closed due to inactivity.' });
    lobby.players.forEach(p => { if (p.id?.readyState === WebSocket.OPEN) { p.id.send(closePayload); p.id.send(JSON.stringify({ type: 'LEFT_LOBBY' })); } });
    lobby.spectators.forEach(s => { if (s.idSocket?.readyState === WebSocket.OPEN) { s.idSocket.send(closePayload); s.idSocket.send(JSON.stringify({ type: 'LEFT_LOBBY' })); } });
    if (lobby.nextHandTimer) clearTimeout(lobby.nextHandTimer);
    delete lobbies[code];
    broadcastLobbyList();
}

function broadcastLobbyEvent(code, payload) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let msg = JSON.stringify(payload);
    lobby.players.forEach(p => { if (p.id?.readyState === WebSocket.OPEN) p.id.send(msg); });
    lobby.spectators.forEach(s => { if (s.idSocket?.readyState === WebSocket.OPEN) s.idSocket.send(msg); });
}

function broadcastVoiceRoster(code) {
    let lobby = lobbies[code];
    if (!lobby) return;
    let roster = [];
    lobby.players.forEach(p => { if (p.inVC) roster.push(p.username); });
    lobby.spectators.forEach(s => { if (s.inVC) roster.push(s.username); });
    broadcastLobbyEvent(code, { type: 'SYNC_VOICE_ROSTER', roster });
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let currentLobbyCode = null;
    let currentUsername = null;

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        try {
            if (currentLobbyCode && lobbies[currentLobbyCode]) {
                touchLobbyActivity(lobbies[currentLobbyCode]);
            }

            switch (data.type) {
                case 'CREATE_LOBBY': {
                    currentUsername = (data.username || 'Player').trim();
                    if (currentLobbyCode && lobbies[currentLobbyCode]) leaveLobby(ws, currentLobbyCode);

                    currentLobbyCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                    lobbies[currentLobbyCode] = {
                        code: currentLobbyCode,
                        name: data.lobbyName || `${currentUsername}'s Lobby`,
                        host: currentUsername,
                        isPrivate: !!data.isPrivate,
                        players: [{ id: ws, username: currentUsername, lives: 2, wager: 5, cards: [], ready: false, seat: 0, nextHandReady: false, eliminated: false, inVC: true, isMuted: true, peekRequests: {}, peekAllowed: {} }],
                        spectators: [],
                        deck: [],
                        discardPile: [],
                        gameState: 'lobby',
                        drawPool: [],
                        drawResults: {},
                        drawOrderSequence: [],
                        tiedParticipantsList: [],
                        phaseMessage: null,
                        initialDealCard: null,
                        lastDiscardPickup: null,
                        lastDiscardDonor: null,
                        fedCardReminders: {},
                        turnIndex: 0,
                        dealerIndex: 0,
                        lastGameWinner: null,
                        sideBetLedger: {},
                        mainGameLedger: {},
                        pendingBets: [],
                        activeBets: [],
                        globalProposals: [],
                        knockedBy: null,
                        finalTurnsRemaining: 0,
                        turnsTakenThisRound: 0,
                        nextHand
