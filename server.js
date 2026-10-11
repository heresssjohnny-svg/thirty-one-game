// server.js - Express Server, LiveKit Voice & WebSocket Dispatcher
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Internal module loaders
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

// Serve static frontend assets from /public and root directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Multi-path static mounts for sound effects (checks root and /public folders)
app.use('/mp3s', express.static(path.join(__dirname, 'mp3s')));
app.use('/mp3s', express.static(path.join(__dirname, 'public', 'mp3s')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use('/audio', express.static(path.join(__dirname, 'public', 'audio')));

// LiveKit WebRTC Token Generator Endpoint with Anti-Cache & Null-Check
app.post('/token', async (req, res) => {
    try {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        const { roomName, participantName } = req.body;
        if (!roomName || !participantName) {
            return res.status(400).json({ error: 'roomName and participantName are required.' });
        }

        const cleanRoom = String(roomName).trim().toUpperCase();
        const cleanName = String(participantName).trim();

        const token = await generateLiveKitToken(cleanRoom, cleanName);

        if (!token) {
            return res.status(500).json({ error: 'LiveKit service failed to generate token.' });
        }

        res.json({
            token,
            host: config.LIVEKIT_HOST,
            room: cleanRoom
        });
    } catch (err) {
        console.error('[LiveKit] Token Generation Error on wake:', err.message);
        res.status(500).json({ error: 'Failed to generate voice token.' });
    }
});

// Single Page Application Fallback (loads root index.html)
// Guard ensures media files never return index.html when missing
app.get('*', (req, res) => {
    if (req.path.match(/\.(mp3|wav|ogg|m4a|aac|js|css|png|jpg|jpeg|gif|ico|svg)$/i)) {
        return res.status(404).send('Asset not found');
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

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

// Connection heartbeat to prune terminated client tunnels
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
    ws.userId = null;
    ws.currentUsername = null;
    ws.currentLobbyCode = null;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    try {
        ws.send(JSON.stringify({
            type: 'LOBBY_LIST',
            lobbies: getPublicLobbiesList()
        }));
    } catch (e) {}

    ws.on('message', async (message) => {
        let parsed;
        try {
            parsed = JSON.parse(message);
        } catch (e) {
            return;
        }

        // 1. Authenticate WebSocket session from stored JWT
        if (parsed.type === 'AUTH_TOKEN') {
            try {
                const token = parsed.token;
                if (token) {
                    const decoded = jwt.verify(token, config.JWT_SECRET || 'blitz31_fallback_super_secret_jwt_key_2026');
                    ws.user = decoded;
                    ws.userId = decoded.id || decoded.userId;
                    ws.currentUsername = decoded.username;
                }
            } catch (err) {
                console.error('[WS Auth] Invalid auth token:', err.message);
            }
            return;
        }

        // 2. Direct Lifetime Ledger query with synchronized property fallbacks
        if (parsed.type === 'GET_LIFETIME_LEDGER') {
            let uid = (ws.user && !ws.user.isGuest) ? (ws.user.id || ws.user.userId) : (ws.userId || null);

            if (!uid && parsed.token) {
                try {
                    const decoded = jwt.verify(parsed.token, config.JWT_SECRET || 'blitz31_fallback_super_secret_jwt_key_2026');
                    ws.user = decoded;
                    uid = decoded.id || decoded.userId;
                    ws.userId = uid;
                    ws.currentUsername = decoded.username;
                } catch (e) {}
            }

            if (!uid) {
                const targetUsername = parsed.username || ws.currentUsername;
                if (targetUsername && db && typeof db.findUserByUsername === 'function') {
                    const found = db.findUserByUsername(targetUsername);
                    if (found && found.id && !found.id.startsWith('gst_')) {
                        uid = found.id;
                        ws.userId = uid;
                    }
                }
            }

            if (uid && db && typeof db.getLifetimeBalances === 'function') {
                const balances = db.getLifetimeBalances(uid);
                ws.send(JSON.stringify({ 
                    type: 'LIFETIME_LEDGER_DATA', 
                    balances: balances,
                    ledger: balances,
                    debts: balances 
                }));
            } else {
                ws.send(JSON.stringify({ 
                    type: 'LIFETIME_LEDGER_DATA', 
                    balances: [],
                    ledger: [],
                    debts: [] 
                }));
            }
            return;
        }

        // 3. Bilateral debt clearance & credit settlement
        if (parsed.type === 'APPLY_CREDIT') {
            if (!ws.user && parsed.token) {
                try {
                    const decoded = jwt.verify(parsed.token, config.JWT_SECRET || 'blitz31_fallback_super_secret_jwt_key_2026');
                    ws.user = decoded;
                    ws.userId = decoded.id || decoded.userId;
                    ws.currentUsername = decoded.username;
                } catch (e) {}
            }

            const debtorId = parsed.debtorId || (ws.user && (ws.user.id || ws.user.userId)) || ws.userId;
            const creditorId = parsed.creditorId;
            const amount = Number(parsed.amount);

            if (debtorId && creditorId && amount > 0 && db && typeof db.recordLifetimeDebt === 'function') {
                db.recordLifetimeDebt(debtorId, creditorId, amount);

                const uid = (ws.user && (ws.user.id || ws.user.userId)) || ws.userId || debtorId;
                const balances = db.getLifetimeBalances(uid);
                ws.send(JSON.stringify({ 
                    type: 'LIFETIME_LEDGER_DATA', 
                    balances: balances,
                    ledger: balances,
                    debts: balances 
                }));

                wss.clients.forEach(client => {
                    const cUid = (client.user && (client.user.id || client.user.userId)) || client.userId;
                    if (client !== ws && client.readyState === WebSocket.OPEN && cUid && (cUid === debtorId || cUid === creditorId)) {
                        try {
                            const cBalances = db.getLifetimeBalances(cUid);
                            client.send(JSON.stringify({ 
                                type: 'LIFETIME_LEDGER_DATA', 
                                balances: cBalances,
                                ledger: cBalances,
                                debts: cBalances 
                            }));
                        } catch (e) {}
                    }
                });
            }
            return;
        }

        // 4. Fast WebSocket token request fallback
        if (parsed.type === 'REQUEST_LIVEKIT_TOKEN') {
            const targetRoom = parsed.room || parsed.code || ws.currentLobbyCode;
            const targetUser = parsed.username || ws.currentUsername || (ws.user && ws.user.username) || 'Player';

            if (targetRoom) {
                try {
                    const cleanRoom = String(targetRoom).trim().toUpperCase();
                    const cleanName = String(targetUser).trim();
                    const token = await generateLiveKitToken(cleanRoom, cleanName);

                    if (token) {
                        ws.send(JSON.stringify({
                            type: 'LIVEKIT_TOKEN',
                            token,
                            host: config.LIVEKIT_HOST,
                            room: cleanRoom
                        }));
                    }
                } catch (err) {
                    console.error('[WS LiveKit] Fast token fallback error:', err.message);
                }
            }
            return;
        }

        // Forward gameplay commands to room and lobby manager
        handleWebSocketMessage(ws, message.toString(), broadcastLobbyList);
    });
});

// -------------------------------------------------------------
// 3. SERVER BOOT & BINDING
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[Blitz 31] HTTP & WebSocket Server running on port ${PORT}`);
});
