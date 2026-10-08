// server/auth.js - PART 1 OF 2
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');
const config = require('./config');

// Initialize Google OAuth2 verification client with your active Client ID
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '420400140659-rpsr8gccd88sbbjiibq0dt2196ftgrb9.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// -------------------------------------------------------------
// 1. GOOGLE IDENTITY SERVICES VERIFIER (Native Prompt)
// -------------------------------------------------------------
router.post('/google', async (req, res) => {
    const { credential } = req.body;
    if (!credential) {
        return res.status(400).json({ error: 'Missing Google credential token.' });
    }

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        if (!payload || !payload.sub) {
            return res.status(401).json({ error: 'Invalid Google token payload.' });
        }

        const providerId = payload.sub;
        const email = payload.email || '';
        let displayName = payload.name || (email ? email.split('@')[0] : 'Player');
        displayName = displayName.trim().slice(0, 15);

        // Check if user already exists
        let user = db.findUserByProviderId(providerId);

        if (!user) {
            // Prevent username collisions
            let uniqueName = displayName;
            let counter = 1;
            while (db.findUserByUsername(uniqueName)) {
                uniqueName = `${displayName}${counter}`;
                counter++;
            }

            const newUserId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
            user = db.createUser(newUserId, 'google', providerId, uniqueName, null);
        }

        const token = jwt.sign(
            { userId: user.id, username: user.username, isGuest: false },
            config.JWT_SECRET,
            { expiresIn: '7d' }
        );

        return res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                isGuest: false
            }
        });
    } catch (err) {
        console.error('[Auth] Google Token Verification failed:', err.message);
        return res.status(401).json({ error: 'Failed to verify Google credential.' });
    }
});

// -------------------------------------------------------------
// 2. STANDARD LOCAL USER REGISTRATION
// -------------------------------------------------------------
router.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const cleanUser = (username || '').trim();

    if (!cleanUser || !password || password.length < 6) {
        return res.status(400).json({ error: 'Username required, and password must be at least 6 characters.' });
    }

    const existing = db.findUserByUsername(cleanUser);
    if (existing) {
        return res.status(409).json({ error: 'Username is already taken.' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        const providerId = `local_${cleanUser.toLowerCase()}`;

        const user = db.createUser(userId, 'local', providerId, cleanUser, passwordHash);
        const token = jwt.sign(
            { userId: user.id, username: user.username, isGuest: false },
            config.JWT_SECRET,
            { expiresIn: '7d' }
        );

        return res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                isGuest: false
            }
        });
    } catch (err) {
        console.error('[Auth] Register error:', err);
        return res.status(500).json({ error: 'Failed to create user account.' });
    }
});
// server/auth.js - PART 2 OF 2

// -------------------------------------------------------------
// 3. STANDARD LOCAL USER LOGIN
// -------------------------------------------------------------
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const cleanUser = (username || '').trim();

    if (!cleanUser || !password) {
        return res.status(400).json({ error: 'Please enter username and password.' });
    }

    const user = db.findUserByUsername(cleanUser);
    if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid username or password.' });
    }

    try {
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const token = jwt.sign(
            { userId: user.id, username: user.username, isGuest: false },
            config.JWT_SECRET,
            { expiresIn: '7d' }
        );

        return res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                isGuest: false
            }
        });
    } catch (err) {
        console.error('[Auth] Login error:', err);
        return res.status(500).json({ error: 'Internal login error.' });
    }
});

// -------------------------------------------------------------
// 4. EPHEMERAL GUEST AUTHENTICATION
// -------------------------------------------------------------
router.post('/guest', (req, res) => {
    const guestId = 'gst_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5);
    const guestUsername = 'Guest_' + Math.floor(1000 + Math.random() * 9000);

    const token = jwt.sign(
        { userId: guestId, username: guestUsername, isGuest: true },
        config.JWT_SECRET,
        { expiresIn: '1d' }
    );

    return res.json({
        token,
        user: {
            id: guestId,
            username: guestUsername,
            isGuest: true
        }
    });
});

// -------------------------------------------------------------
// 5. SESSION VERIFICATION (/auth/me)
// -------------------------------------------------------------
router.get('/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        return res.json({
            user: {
                id: decoded.userId,
                username: decoded.username,
                isGuest: !!decoded.isGuest
            }
        });
    } catch (err) {
        return res.status(401).json({ error: 'Session expired or invalid.' });
    }
});

module.exports = router;
