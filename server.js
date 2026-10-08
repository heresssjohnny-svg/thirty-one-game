// server.js - Express Server, LiveKit Access & WebSocket Hookup (PART 1 OF 2)
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

// Safe internal module loaders
const config = require('./server/config');
const db = require('./server/db');
const authRouter = require('./server/auth');
const { generateLiveKitToken } = require('./server/services/livekit');
const { handleWebSocketMessage } = require('./server/game/wsHandler');
const { getPublicLobbiesList, leaveLobby } = require('./server/game/lobbyManager');

const app = express();
const server = http.createServer(app);

// -------------------------------------------------------------
// 1. MIDDLEWARE & ROUTING CONFIGURATION
// -------------------------------------------------------------
// Body parsers for auth actions and API payloads
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount Authentication Router (/auth/register, /auth/login, /auth/guest, /auth/google, /auth/me)
app.use('/auth', authRouter);

// Serve static frontend assets from /public and project root
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// LiveKit WebRTC Token Generator Endpoint
app.post('/token', async (req, res) => {
    try {
        const { roomName, participantName } = req.body;
        if (!roomName || !participantName) {
            return res.status(400).json({ error: 'roomName and participantName are required.' });
        }
        const token = await generateLiveKitToken(roomName, participantName);
        res.json({ token, host: config.LIVEKIT_HOST });
    } catch (err) {
        console.error('[LiveKit] Token Generation Error:', err.message);
        res.status(500).json({ error: 'Failed to generate voice token.' });
    }
});

// Single Page Application Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// server.js - PART 2 OF 2

// -------------------------------------------------------------
// 2. WEBSOCKET SERVER & REAL-TIME DISPATCH
// -------------------------------------------------------------
const wss = new WebSocket.Server({ server });

function broadcastLobbyList() {
    const listPayload = JSON.stringify({
        type: 'LOBBY_LIST',
        lobbies: getPublicLobbiesList()
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && !client.currentLobbyCode) {
            client.send(listPayload);
        }
    });
}

// Connection heartbeat to cleanly prune broken client tunnels
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (e) {}
    });
}, 30000);

wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.user = null;
    ws.currentUsername = null;
    ws.currentLobbyCode = null;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    // Provide initial available lobby list upon socket handshake
    try {
        ws.send(JSON.stringify({
            type: 'LOBBY_LIST',
            lobbies: getPublicLobbiesList()
        }));
    } catch (e) {}

    ws.on('message', (message) => {
        let parsed;
        try {
            parsed = JSON.parse(message);
        } catch (e) {
            return;
        }

        // Direct Lifetime Ledger & Credit WebSocket Interceptors
        if (parsed.type === 'GET_LIFETIME_LEDGER') {
            const uid = ws.user ? ws.user.userId : (db && typeof db.findUserByUsername === 'function' && ws.currentUsername && db.findUserByUsername(ws.currentUsername)?.id);
            if (uid && db && typeof db.getLifetimeBalances === 'function') {
                const balances = db.getLifetimeBalances(uid);
                ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances }));
            }
            return;
        }

        if (parsed.type === 'APPLY_CREDIT') {
            const debtorId = parsed.debtorId;
            const creditorId = parsed.creditorId;
            const amount = Number(parsed.amount);

            if (debtorId && creditorId && amount > 0 && db && typeof db.recordLifetimeDebt === 'function') {
                db.recordLifetimeDebt(debtorId, creditorId, amount);
                const uid = ws.user ? ws.user.userId : debtorId;
                const balances = db.getLifetimeBalances(uid);
                ws.send(JSON.stringify({ type: 'LIFETIME_LEDGER_DATA', balances }));
            }
            return;
        }

        // Forward message to the exported wsHandler function
        handleWebSocketMessage(ws, message.toString(), broadcastLobbyList);
    });

    ws.on('close', () => {
        if (ws.currentLobbyCode) {
            leaveLobby(ws, ws.currentLobbyCode, broadcastLobbyList);
        }
    });
});

// -------------------------------------------------------------
// 3. SERVER BOOT & BINDING
// -------------------------------------------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`[Blitz 31] HTTP & WebSocket Server running on port ${PORT}`);
});
