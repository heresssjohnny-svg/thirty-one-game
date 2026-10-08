// server/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Support both server/auth.js and root directory layouts
const db = fs.existsSync(path.join(__dirname, 'db.js'))
    ? require('./db')
    : (fs.existsSync(path.join(__dirname, 'server', 'db.js')) ? require('./server/db') : require('../db'));

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'thirtyone-super-secret-jwt-key-2026';

/**
 * Creates a signed JWT session token valid for 30 days
 */
function createToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

/**
 * Helper to decode and verify JWTs on Express routes or WebSocket handshakes
 */
function verifyToken(token) {
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

// -------------------------------------------------------------
// 1. NATIVE 31 REGISTRATION
// -------------------------------------------------------------
router.post('/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const cleanUsername = username.trim();

        if (cleanUsername.length < 2 || cleanUsername.length > 20) {
            return res.status(400).json({ error: 'Username must be between 2 and 20 characters.' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
        }

        // Check for existing account with this email
        const existing = db.findUserByProviderId(normalizedEmail);
        if (existing) {
            return res.status(409).json({ error: 'An account with that email already exists.' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const userId = 'usr_' + crypto.randomBytes(6).toString('hex');

        const newUser = db.createUser(userId, '31', normalizedEmail, cleanUsername, passwordHash);
        const token = createToken({ userId: newUser.id, username: newUser.username, isGuest: false });

        return res.json({
            token,
            user: {
                id: newUser.id,
                username: newUser.username,
                provider: '31',
                isGuest: false
            }
        });
    } catch (err) {
        console.error('Registration error:', err);
        return res.status(500).json({ error: 'Server error during registration.' });
    }
});

// -------------------------------------------------------------
// 2. NATIVE 31 LOGIN
// -------------------------------------------------------------
router.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = db.findUserByProviderId(normalizedEmail);

        if (!user || !user.password_hash) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const passwordValid = await bcrypt.compare(password, user.password_hash);
        if (!passwordValid) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const token = createToken({ userId: user.id, username: user.username, isGuest: false });

        return res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                provider: user.provider,
                isGuest: false
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Server error during login.' });
    }
});

// -------------------------------------------------------------
// 3. GUEST PLAY (No DB record, lifetime ledger ignored)
// -------------------------------------------------------------
router.post('/auth/guest', (req, res) => {
    try {
        const customName = req.body.username ? req.body.username.trim() : '';
        const guestName = customName || `Guest_${Math.floor(1000 + Math.random() * 9000)}`;
        const guestId = 'gst_' + crypto.randomBytes(6).toString('hex');

        const token = createToken({ userId: guestId, username: guestName, isGuest: true });

        return res.json({
            token,
            user: {
                id: guestId,
                username: guestName,
                provider: 'guest',
                isGuest: true
            }
        });
    } catch (err) {
        console.error('Guest login error:', err);
        return res.status(500).json({ error: 'Server error during guest creation.' });
    }
});

// -------------------------------------------------------------
// 4. SOCIAL LOGINS (Google, Facebook, Instagram)
// -------------------------------------------------------------
router.post('/auth/social', async (req, res) => {
    try {
        const { provider, providerId, username, email } = req.body;

        const allowedProviders = ['google', 'facebook', 'instagram'];
        if (!provider || !allowedProviders.includes(provider.toLowerCase())) {
            return res.status(400).json({ error: 'Unsupported authentication provider.' });
        }

        if (!providerId) {
            return res.status(400).json({ error: 'Missing social profile identifier.' });
        }

        const normalizedProvider = provider.toLowerCase();
        // Unique key for the social account row: e.g., "google:104928374928"
        const uniqueProviderKey = `${normalizedProvider}:${providerId.toString().trim()}`;

        let user = db.findUserByProviderId(uniqueProviderKey);

        if (!user) {
            const fallbackName = username ? username.trim() : `${normalizedProvider.toUpperCase()}_User`;
            const userId = 'usr_' + crypto.randomBytes(6).toString('hex');

            user = db.createUser(
                userId,
                normalizedProvider,
                uniqueProviderKey,
                fallbackName,
                null // Passwords are not stored for OAuth accounts
            );
        }

        const token = createToken({ userId: user.id, username: user.username, isGuest: false });

        return res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                provider: user.provider,
                isGuest: false
            }
        });
    } catch (err) {
        console.error('Social login error:', err);
        return res.status(500).json({ error: 'Server error during social authentication.' });
    }
});

// -------------------------------------------------------------
// 5. SESSION VERIFICATION (/auth/me)
// -------------------------------------------------------------
router.get('/auth/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing authentication token.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) {
        return res.status(401).json({ error: 'Invalid or expired session token.' });
    }

    if (decoded.isGuest) {
        return res.json({
            user: {
                id: decoded.userId,
                username: decoded.username,
                provider: 'guest',
                isGuest: true
            }
        });
    }

    const user = db.findUserById(decoded.userId);
    if (!user) {
        return res.status(404).json({ error: 'Account not found.' });
    }

    return res.json({
        user: {
            id: user.id,
            username: user.username,
            provider: user.provider,
            isGuest: false
        }
    });
});

module.exports = {
    router,
    verifyToken,
    JWT_SECRET
};
