// server/config.js - Core Environment Configuration & LiveKit Keys

module.exports = {
    // Server Port: Hetzner Node backend runs on 3000 (proxied by Caddy)
    PORT: process.env.PORT || 3000,

    // Session token signing secret fallback
    JWT_SECRET: process.env.JWT_SECRET || 'blitz31_fallback_super_secret_jwt_key_2026',

    // LiveKit SFU Host Domain
    LIVEKIT_HOST: process.env.LIVEKIT_HOST || 'wss://31game.duckdns.org',

    // Active LiveKit Credentials
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || 'thirtyone-chat',
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e',

    // Inactivity threshold before cleaning up abandoned rooms (20 minutes)
    INACTIVITY_TIMEOUT_MS: 20 * 60 * 1000
};
