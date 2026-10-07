// server/config.js
module.exports = {
    PORT: process.env.PORT || 3000,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || 'thirtyone-chat',
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e',
    LIVEKIT_HOST: process.env.LIVEKIT_HOST || 'wss://31game.duckdns.org',
    INACTIVITY_TIMEOUT_MS: 20 * 60 * 1000 // 20 minutes
};
