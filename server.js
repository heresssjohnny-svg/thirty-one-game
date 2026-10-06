// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const config = require('./server/config');
const { generateLiveKitToken } = require('./server/services/livekit');
const { setupWebSocket } = require('./server/game/wsHandler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

// Serve static assets from public/ or root
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
if (fs.existsSync(path.join(__dirname, 'www'))) {
    app.use(express.static(path.join(__dirname, 'www')));
}

// REST route for LiveKit tokens
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

// WebSocket heartbeat watchdog
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

wss.on('close', () => clearInterval(heartbeatInterval));

// Initialize WS message dispatcher
setupWebSocket(wss);

server.listen(config.PORT, '0.0.0.0', () => {
    console.log(`31! Card Game server running on port ${config.PORT}`);
});
