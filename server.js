// server.js - Master Application Coordinator & WebSocket Server
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => console.error('[SERVER] Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('[SERVER] Unhandled Rejection at:', promise, 'reason:', reason));

// -------------------------------------------------------------
// 1. CONFIGURATION & MODULE RESOLUTION
// -------------------------------------------------------------
let config = {
    PORT: process.env.PORT || 10000,
    LIVEKIT_HOST: process.env.LIVEKIT_HOST || 'wss://31game.duckdns.org',
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || 'thirtyone-chat',
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e'
};

for (const p of ['./server/config', './config']) {
    try {
        config = { ...config, ...require(p) };
        break;
    } catch (e) {}
}

// Resilient Database & Auth Loaders
let db = null;
for (const p of ['./server/db', './db']) {
    try { db = require(p); break; } catch (e) {}
}

let auth = null;
for (const p of ['./server/auth', './auth']) {
    try { auth = require(p); break; } catch (e) {}
}

// Resilient LiveKit Token Generator
let generateLiveKitToken = null;
for (const p of ['./server/services/livekit', './services/livekit', './server/livekit']) {
    try {
        const mod = require(p);
        if (typeof mod.generateLiveKitToken === 'function') {
            generateLiveKitToken = mod.generateLiveKitToken;
            break;
        }
    } catch (e) {}
}

if (!generateLiveKitToken) {
    try {
        const { AccessToken } = require('livekit-server-sdk');
        generateLiveKitToken = async (roomName, participantName) => {
            try {
                const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
                    identity: participantName,
                    name: participantName,
                    ttl: '8h'
                });
                at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
                return await at.toJwt();
            } catch (err) {
                console.error('[LIVEKIT] Token Generation Error:', err);
                return null;
            }
        };
    } catch (err) {
        generateLiveKitToken = async () => null;
    }
}

// Resilient Game Engine Loaders
let setupWebSocket = null;
for (const p of ['./server/game/wsHandler', './game/wsHandler', './server/wsHandler']) {
    try {
        const mod = require(p);
        if (typeof mod.setupWebSocket === 'function') {
            setupWebSocket = mod.setupWebSocket;
            break;
        }
    } catch (e) {}
}

let getPublicLobbiesList = null;
for (const p of ['./server/game/lobbyManager', './game/lobbyManager', './server/lobbyManager']) {
    try {
        const mod = require(p);
        if (typeof mod.getPublicLobbiesList === 'function') {
            getPublicLobbiesList = mod.getPublicLobbiesList;
            break;
        }
    } catch (e) {}
}

// -------------------------------------------------------------
// 2. EXPRESS APPLICATION & ROUTE DEFINITIONS
// -------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount Authentication Endpoints (/auth/register, /auth/login, /auth/guest, /auth/social)
if (auth && auth.router) {
    app.use(auth.router);
}

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
if (fs.existsSync(path.join(__dirname, 'www'))) {
    app.use(express.static(path.join(__dirname, 'www')));
}

// REST Route for LiveKit Tokens
app.get('/token', async (req, res) => {
    const room = (req.query.room || 'test-room').trim();
    const username = (req.query.username || `User-${Math.floor(Math.random() * 1000)}`).trim();
    try {
        const token = await generateLiveKitToken(room, username);
        if (!token) return res.status(500).json({ error: 'Failed to generate token' });
        res.json({ token, host: config.LIVEKIT_HOST, room, username });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('*', (req, res) => {
    const candidates = [
        path.join(__dirname, 'public', 'index.html'),
        path.join(__dirname, 'index.html'),
        path.join(__dirname, 'www', 'index.html')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return res.sendFile(p);
    }
    res.status(404).send('index.html not found.');
});

// -------------------------------------------------------------
// 3. WEBSOCKET HEARTBEAT & LIFETIME LEDGER LISTENER
// -------------------------------------------------------------
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

wss.on('close', () => clearInterval(heartbeatInterval));

function broadcastLobbyList() {
    if (typeof getPublicLobbiesList === 'function') {
        const list = getPublicLobbiesList();
        const payload = JSON.stringify({ type: 'LOBBY_LIST', lobbies: list });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
}

// Global WebSocket handler for Auth & Lifetime Ledger queries
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (!data || typeof data !== 'object') return;

            // 1. Authenticate WebSocket Connection
            if (data.type === 'AUTH_TOKEN' && auth && typeof auth.verifyToken === 'function') {
                const decoded = auth.verifyToken(data.token);
                if (decoded) ws.user = decoded;
            }

            // 2. Query Lifetime Ledger Balances
            if (data.type === 'GET_LIFETIME_LEDGER' && db) {
                const userId = (ws.user && ws.user.userId) || data.userId;
                const isGuest = ws.user ? !!ws.user.isGuest : !!data.isGuest;

                if (!isGuest && userId) {
                    const balances = db.getLifetimeBalances(userId);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances }));
                    }
                } else {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances: [], isGuest: true }));
                    }
                }
            }

            // 3. Apply Credit towards Opponent Debt
            if (data.type === 'APPLY_CREDIT' && db) {
                const creditorId = (ws.user && ws.user.userId) || data.userId;
                const isGuest = ws.user ? !!ws.user.isGuest : !!data.isGuest;

                if (!isGuest && creditorId && data.debtorId && data.amount) {
                    const result = db.applyCredit(creditorId, data.debtorId, Number(data.amount));
                    const balances = db.getLifetimeBalances(creditorId);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances, creditResult: result }));
                    }
                }
            }
        } catch (err) {}
    });
});

// Mount the Modular Gameplay Engine
if (typeof setupWebSocket === 'function') {
    setupWebSocket(wss, broadcastLobbyList);
}

// -------------------------------------------------------------
// 4. SERVER LAUNCH
// -------------------------------------------------------------
const PORT = config.PORT || process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`31! Card Game server running on port ${PORT}`);
});
