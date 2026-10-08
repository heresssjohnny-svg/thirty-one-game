// server/config.js - Server Configuration & Environment Variables

module.exports = {
    // Port binding: Render dynamically assigns PORT, fallback to 10000 / 3000
    PORT: process.env.PORT || 10000,

    // Critical: Secret key for signing and verifying JWT tokens
    JWT_SECRET: process.env.JWT_SECRET || 'blitz31_fallback_super_secret_jwt_key_2026',

    // Hetzner LiveKit SFU credentials & host
    LIVEKIT_HOST: process.env.LIVEKIT_HOST || 'wss://31game.duckdns.org',
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || 'devkey',
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || 'secret',

    // Inactivity threshold before cleaning up empty rooms
    INACTIVITY_TIMEOUT_MS: 20 * 60 * 1000
};
