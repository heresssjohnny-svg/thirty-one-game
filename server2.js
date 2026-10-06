const express = require('express');
const http = require('http');
const path = require('path');
const { AccessToken } = require('livekit-server-sdk'); //[span_2](start_span)[span_2](end_span)

const app = express();
const server = http.createServer(app);

// LiveKit configuration matching your VPS setup[span_3](start_span)[span_3](end_span)[span_4](start_span)[span_4](end_span)
const LIVEKIT_API_KEY = 'thirtyone-chat';
const LIVEKIT_API_SECRET = '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e';
const LIVEKIT_HOST = 'ws://135.181.43.233:7880'; //[span_5](start_span)[span_5](end_span)

app.use(express.static(__dirname));

// Serve the test client
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index2.html'));
});

// Asynchronous token generation endpoint[span_6](start_span)[span_6](end_span)[span_7](start_span)[span_7](end_span)
app.get('/token', async (req, res) => {
    const room = (req.query.room || 'test-room').trim();
    const username = (req.query.username || `User-${Math.floor(Math.random() * 1000)}`).trim();

    try {
        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: username,
            name: username,
            ttl: '4h',
        });

        at.addGrant({
            roomJoin: true,
            room: room,
            canPublish: true,
            canSubscribe: true,
        }); //[span_8](start_span)[span_8](end_span)

        // AccessToken.prototype.toJwt() returns a Promise in modern livekit-server-sdk[span_9](start_span)[span_9](end_span)
        const token = await at.toJwt(); //[span_10](start_span)[span_10](end_span)

        console.log(`[Token Generated] Room: "${room}", User: "${username}"`);
        res.json({
            token,
            host: LIVEKIT_HOST,
            room,
            username
        });
    } catch (err) {
        console.error('Failed to generate LiveKit token:', err);
        res.status(500).json({ error: 'Failed to create access token' });
    }
});

const PORT = process.env.TEST_PORT || 3001;
server.listen(PORT, () => {
    console.log(`LiveKit Voice Tester running at http://localhost:${PORT}`);
});
