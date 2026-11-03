// server/config.js - Core Environment Configuration & Service Credentials
//
// Values are read from environment variables first (load them from a .env file
// in the project root — see .env.example). The fallbacks below keep the server
// bootable out of the box, but any deployment reachable from the internet should
// override every secret via .env or the process environment.

const path = require('path');

try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
    // dotenv is optional; environment variables may already be provided by the host
}

const config = {
    // Server Port: Hetzner Node backend runs on 3000 (proxied by Caddy)
    PORT: Number(process.env.PORT) || 3000,

    // Session token signing secret fallback
    JWT_SECRET: process.env.JWT_SECRET || 'blitz31_fallback_super_secret_jwt_key_2026',

    // LiveKit SFU Host Domain
    LIVEKIT_HOST: process.env.LIVEKIT_HOST || process.env.LIVEKIT_URL || 'wss://31game.duckdns.org',

    // Active LiveKit Credentials
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || 'thirtyone-chat',
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || '33736f394e4ac3e661285131f11d67a3a97865f80500ba607bb4dca969208e5e',

    // Password-recovery email sender (Gmail SMTP app password)
    SMTP_EMAIL: process.env.SMTP_EMAIL || 'heresssjohnny@gmail.com',
    SMTP_PASSWORD: process.env.SMTP_PASSWORD || 'ybsg sbmt dctc soqj',

    // Developer / admin portal credentials (admin.html -> /auth/admin/login)
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'Blitz31Admin!2026',

    // Inactivity threshold before cleaning up abandoned rooms (5 minutes)
    INACTIVITY_TIMEOUT_MS: Number(process.env.INACTIVITY_TIMEOUT_MS) || 5 * 60 * 1000,

    // How long the table is "shuffling & dealing" at the start of every hand.
    // No turn actions, bot moves or turn timers run until this window ends;
    // the client animation (public/js/dealAnim.js) sizes itself to fit it.
    DEAL_ANIMATION_MS: Number(process.env.DEAL_ANIMATION_MS) || 16000
};

// Warn loudly (but keep running) when production is still on fallback secrets
if (process.env.NODE_ENV === 'production') {
    const usingFallback = [];
    if (!process.env.JWT_SECRET) usingFallback.push('JWT_SECRET');
    if (!process.env.LIVEKIT_API_SECRET) usingFallback.push('LIVEKIT_API_SECRET');
    if (!process.env.SMTP_PASSWORD) usingFallback.push('SMTP_PASSWORD');
    if (!process.env.ADMIN_PASSWORD) usingFallback.push('ADMIN_PASSWORD');
    if (usingFallback.length) {
        console.warn(`[Config] WARNING: running with hardcoded fallback secrets for: ${usingFallback.join(', ')}. Set them in .env.`);
    }
}

module.exports = config;
