// server/services/livekit.js
const path = require('path');
const fs = require('fs');

// Attempt to load AccessToken from livekit-server-sdk
let AccessToken;
try {
    AccessToken = require('livekit-server-sdk').AccessToken;
} catch (e) {
    console.warn('[LiveKit] "livekit-server-sdk" package is not installed. Voice tokens will not generate.');
}

// Robust configuration loader supporting multiple directory layouts
let config;
if (fs.existsSync(path.join(__dirname, '..', 'config.js'))) {
    config = require('../config');
} else if (fs.existsSync(path.join(__dirname, '..', '..', 'config.js'))) {
    config = require('../../config');
} else if (fs.existsSync(path.join(__dirname, 'config.js'))) {
    config = require('./config');
} else {
    config = {
        LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || '',
        LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || '',
        LIVEKIT_HOST: process.env.LIVEKIT_HOST || ''
    };
}

async function generateLiveKitToken(roomName, participantName) {
    if (!AccessToken) {
        console.error('[LiveKit] AccessToken class unavailable. Run "npm install livekit-server-sdk".');
        return null;
    }

    const apiKey = config.LIVEKIT_API_KEY || process.env.LIVEKIT_API_KEY;
    const apiSecret = config.LIVEKIT_API_SECRET || process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
        console.error('[LiveKit] Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET in config or environment variables.');
        return null;
    }

    try {
        const at = new AccessToken(apiKey, apiSecret, {
            identity: participantName,
            name: participantName,
            ttl: '8h'
        });

        at.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canPublishData: true,
            canSubscribe: true
        });

        return await at.toJwt();
    } catch (err) {
        console.error('[LiveKit] Failed to generate token for', participantName, ':', err);
        return null;
    }
}

module.exports = { generateLiveKitToken };
