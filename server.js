// server.js - Express Server, LiveKit Voice & WebSocket Dispatcher
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Internal module loaders
const config = require('./server/config');
const db = require('./server/db');
const authRouter = require('./server/auth');
const { generateLiveKitToken } = require('./server/services/livekit');
const {
    handleWebSocketMessage,
    clearReadyCountdown,
    resetTurnTimer
} = require('./server/game/wsHandler');
const {
    lobbies,
    getPublicLobbiesList,
    touchLobbyActivity,
    broadcastLobbyUpdate
} = require('./server/game/lobbyManager');

const app = express();
const server = http.createServer(app);

// Helper to reliably locate index.html without exposing sensitive root files
function getIndexHtmlPath() {
    const publicIndex = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(publicIndex)) {
        return publicIndex;
    }
    return path.join(__dirname, 'index.html');
}

// -------------------------------------------------------------
// 1. MIDDLEWARE & ROUTING CONFIGURATION
// -------------------------------------------------------------
// Body parsers for auth actions and API payloads
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount Authentication & Admin Router (/auth/register, /auth/login, /auth/admin/*, etc.)
app.use('/auth', authRouter);

// Serve static frontend assets from /public
app.use(express.static(path.join(__dirname, 'public')));

// Explicit static mounts for sound effects (checks both root and public directories)
app.use('/mp3s', express.static(path.join(__dirname, 'mp3s')));
app.use('/mp3s', express.static(path.join(__dirname, 'public', 'mp3s')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use('/audio', express.static(path.join(__dirname, 'public', 'audio')));

// Safely serve root-level PWA & audio files if located in root directory
const SAFE_ROOT_FILES = ['manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'background-music.mp3'];
SAFE_ROOT_FILES.forEach(file => {
    app.get(`/${file}`, (req, res, next) => {
        const rootFilePath = path.join(__dirname, file);
        if (fs.existsSync(rootFilePath)) {
            return res.sendFile(rootFilePath);
        }
        next();
    });
});

// Serve any standalone .html file placed in the project root or /public
// (e.g., /admin.html, /admin, /accdelete.html, /privacy.html, /icon.html)
// so it loads its own page instead of falling through to the main game index.html
app.get('/:page', (req, res, next) => {
    const rawPage = (req.params.page || '').trim();
    if (!rawPage) return next();

    // Ignore non-HTML static extensions (.js, .css, .png, etc.)
    if (rawPage.includes('.') && !rawPage.toLowerCase().endsWith('.html')) {
        return next();
    }

    const cleanBase = path.basename(rawPage, '.html');
    const lowerBase = cleanBase.toLowerCase();

    // Let index, auth, and token routes proceed normally
    if (!cleanBase || lowerBase === 'index' || lowerBase === 'auth' || lowerBase === 'token') {
        return next();
    }

    const targetFileName = `${cleanBase}.html`;
    const publicHtmlPath = path.join(__dirname, 'public', targetFileName);
    const rootHtmlPath = path.join(__dirname, targetFileName);

    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });

    if (fs.existsSync(publicHtmlPath)) {
        return res.sendFile(publicHtmlPath);
    }
    if (fs.existsSync(rootHtmlPath)) {
        return res.sendFile(rootHtmlPath);
    }

    // Also support case-insensitive filename matching on Linux (Hetzner)
    try {
        const rootMatch = fs.readdirSync(__dirname).find(
            f => f.toLowerCase() === targetFileName.toLowerCase()
        );
        if (rootMatch) {
            return res.sendFile(path.join(__dirname, rootMatch));
        }
        const pubDir = path.join(__dirname, 'public');
        if (fs.existsSync(pubDir)) {
            const pubMatch = fs.readdirSync(pubDir).find(
                f => f.toLowerCase() === targetFileName.toLowerCase()
            );
            if (pubMatch) {
                return res.sendFile(path.join(pubDir, pubMatch));
            }
        }
    } catch (e) {}

    if (rawPage.toLowerCase().endsWith('.html')) {
        return res.status(404).send(`HTML file "${targetFileName}" was not found on the server.`);
    }

    next();
});

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

        const resolvedHost = config.LIVEKIT_HOST || process.env.LIVEKIT_HOST || process.env.LIVEKIT_URL;

        res.json({
            token,
            host: resolvedHost,
            room: cleanRoom
        });
    } catch (err) {
        console.error('[LiveKit] Token Generation Error on wake:', err.message);
        res.status(500).json({ error: 'Failed to generate voice token.' });
    }
});

// Single Page Application Fallback:
// Guard ensures missing audio, script, or .html assets return 404 rather than the game page
app.get('*', (req, res) => {
    if (req.path.match(/\.(mp3|wav|ogg|m4a|aac|js|css|png|jpg|jpeg|gif|ico|svg|map|html)$/i)) {
        return res.status(404).send('Asset not found');
    }
    res.sendFile(getIndexHtmlPath());
});

// -------------------------------------------------------------
// 2. WEBSOCKET SERVER & REAL-TIME DISPATCH
// -------------------------------------------------------------
const wss = new WebSocket.Server({ server });
global.blitz31Wss = wss;

function broadcastLobbyList() {
    const listPayload = JSON.stringify({
        type: 'LOBBY_LIST',
        lobbies: getPublicLobbiesList()
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            // Clear stale room reference if that lobby was closed
            if (client.currentLobbyCode && !lobbies[client.currentLobbyCode]) {
                client.currentLobbyCode = null;
            }
            if (!client.currentLobbyCode) {
                client.send(listPayload);
            }
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
    ws.accountUsername = null;
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
        // Mark socket alive on any incoming message (including client PINGs)
        ws.isAlive = true;

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
                    if (decoded.username) {
                        ws.accountUsername = decoded.username;
                        if (!ws.currentUsername) {
                            ws.currentUsername = decoded.username;
                        }
                    }

                    // If socket already joined a lobby before AUTH_TOKEN completed, attach userId to their seat
                    if (ws.currentLobbyCode && lobbies[ws.currentLobbyCode] && ws.userId && !String(ws.userId).startsWith('gst_')) {
                        const activeLobby = lobbies[ws.currentLobbyCode];
                        const p = activeLobby.players.find(pl => pl.id === ws);
                        if (p) {
                            p.userId = ws.userId;
                            if (ws.accountUsername) p.accountUsername = ws.accountUsername;
                        }
                        const s = (activeLobby.spectators || []).find(sp => sp.idSocket === ws);
                        if (s) {
                            s.userId = ws.userId;
                            if (ws.accountUsername) s.accountUsername = ws.accountUsername;
                        }
                    }

                    ws.send(JSON.stringify({
                        type: 'AUTH_SUCCESS',
                        user: decoded
                    }));
                }
            } catch (err) {
                console.error('[WS Auth] Invalid auth token:', err.message);
                ws.send(JSON.stringify({
                    type: 'AUTH_ERROR',
                    message: 'Invalid or expired session token.'
                }));
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
                    if (decoded.username) {
                        ws.accountUsername = decoded.username;
                        if (!ws.currentUsername) ws.currentUsername = decoded.username;
                    }
                } catch (e) {}
            }

            if (!uid) {
                const targetUsername = parsed.accountUsername || parsed.username || ws.accountUsername || ws.currentUsername;
                if (targetUsername && db && typeof db.findUserByUsername === 'function') {
                    const found = db.findUserByUsername(targetUsername);
                    if (found && found.id && !String(found.id).startsWith('gst_')) {
                        uid = found.id;
                        ws.userId = uid;
                    }
                }
            }

            if (uid && !String(uid).startsWith('gst_') && db && typeof db.getLifetimeBalances === 'function') {
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
                    if (decoded.username) {
                        ws.accountUsername = decoded.username;
                        if (!ws.currentUsername) ws.currentUsername = decoded.username;
                    }
                } catch (e) {}
            }

            let debtorId = parsed.debtorId || (ws.user && (ws.user.id || ws.user.userId)) || ws.userId;
            if (!debtorId) {
                const lookupName = parsed.accountUsername || parsed.username || ws.accountUsername || ws.currentUsername;
                if (lookupName && db && typeof db.findUserByUsername === 'function') {
                    debtorId = db.findUserByUsername(lookupName)?.id || null;
                }
            }

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
                        const resolvedHost = config.LIVEKIT_HOST || process.env.LIVEKIT_HOST || process.env.LIVEKIT_URL;
                        ws.send(JSON.stringify({
                            type: 'LIVEKIT_TOKEN',
                            token,
                            host: resolvedHost,
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

    // Clean up player/spectator state when a socket disconnects
    ws.on('close', () => {
        if (ws.currentLobbyCode && lobbies[ws.currentLobbyCode]) {
            const lobby = lobbies[ws.currentLobbyCode];
            const disconnectedUid = (ws.user && !ws.user.isGuest && (ws.user.id || ws.user.userId)) || ws.userId || null;

            const player = lobby.players.find(p => p.id === ws);
            if (player) {
                if (typeof clearReadyCountdown === 'function') {
                    clearReadyCountdown(player);
                }
                if (disconnectedUid && !String(disconnectedUid).startsWith('gst_')) {
                    player.userId = disconnectedUid;
                }
                if (ws.accountUsername && !player.accountUsername) {
                    player.accountUsername = ws.accountUsername;
                }
                player.id = null;
                player.disconnectedAt = Date.now();

                // If it was this player's active turn, switch their turn timer to the 5s offline fast-play AI timer
                if (
                    (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') &&
                    lobby.players[lobby.turnIndex] === player &&
                    typeof resetTurnTimer === 'function'
                ) {
                    resetTurnTimer(lobby);
                }

                if (lobby.endGameVote) {
                    const seatedHumans = lobby.players.filter(p => !p.isBot && p.id !== null);
                    if (seatedHumans.length <= 1) {
                        lobby.endGameVote = null;
                    }
                }

                broadcastLobbyUpdate(ws.currentLobbyCode);
            }

            const spec = (lobby.spectators || []).find(s => s.idSocket === ws);
            if (spec) {
                if (disconnectedUid && !String(disconnectedUid).startsWith('gst_')) {
                    spec.userId = disconnectedUid;
                }
                if (ws.accountUsername && !spec.accountUsername) {
                    spec.accountUsername = ws.accountUsername;
                }
                spec.idSocket = null;
                spec.disconnectedAt = Date.now();
            }

            touchLobbyActivity(lobby, broadcastLobbyList);
        }
    });
});

// -------------------------------------------------------------
// 3. SERVER BOOT & BINDING
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[Blitz 31] HTTP & WebSocket Server running on port ${PORT}`);
});
