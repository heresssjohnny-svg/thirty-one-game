// server/services/livekit.js
const { AccessToken } = require('livekit-server-sdk');
const config = require('../config');

async function generateLiveKitToken(roomName, participantName) {
    try {
        const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
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
        console.error('Failed to generate LiveKit token:', err);
        return null;
    }
}

module.exports = { generateLiveKitToken };

