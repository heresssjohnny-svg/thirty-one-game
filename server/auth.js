// server/auth.js - Local Email-Linked Authentication, Password Recovery & Developer Admin API
const express = require('express');
const router = express.Router();

// Usernames are shown all over the table and admin panel, so characters that can break HTML or
// quoted onclick handlers are not allowed. Returns an error message or null.
const UNSAFE_NAME = /[<>"'`&\\\u0000-\u001f\u007f]/;
function usernameProblem(name) {
    if (!name) return 'Username required.';
    if (name.length > 24) return 'Username must be 24 characters or fewer.';
    if (UNSAFE_NAME.test(name)) return 'Usernames cannot contain < > " \' ` & or \\.';
    return null;
}
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const WebSocket = require('ws');
const db = require('./db');
const config = require('./config');
const { clientIp } = require('./guest');
const { lobbies, broadcastLobbyUpdate, resetLobbyToReadyRoom } = require('./game/lobbyManager');

// All credentials come from server/config.js (which reads .env / process.env)
const JWT_SECRET = config.JWT_SECRET;

// Helper to access raw better-sqlite3 instance safely
const sqlDb = typeof db.prepare === 'function' ? db : db.db;

// -------------------------------------------------------------
// EMAIL / SMTP CONFIGURATION
// -------------------------------------------------------------
const SMTP_EMAIL = config.SMTP_EMAIL;
const SMTP_PASSWORD = String(config.SMTP_PASSWORD || '');

const mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: SMTP_EMAIL,
        pass: SMTP_PASSWORD.replace(/\s+/g, '')
    }
});

// -------------------------------------------------------------
// 1. REGISTRATION (WITH LINKED EMAIL)
// -------------------------------------------------------------
router.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    const cleanUser = (username || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanUser || !password || password.length < 6) {
        return res.status(400).json({ error: 'Username required, and password must be at least 6 characters.' });
    }
    const nameErr = usernameProblem(cleanUser);
    if (nameErr) return res.status(400).json({ error: nameErr });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!cleanEmail || !emailRegex.test(cleanEmail)) {
        return res.status(400).json({ error: 'A valid email address is required for password recovery.' });
    }

    if (db.findUserByUsername(cleanUser)) {
        return res.status(409).json({ error: 'Username is already taken.' });
    }

    if (typeof db.findUserByEmail === 'function' && db.findUserByEmail(cleanEmail)) {
        return res.status(409).json({ error: 'This email is already registered.' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        const providerId = `local_${cleanUser.toLowerCase()}`;

        sqlDb.prepare(`
            INSERT INTO users (id, provider, provider_id, username, email, password_hash, created_at)
            VALUES (?, 'local', ?, ?, ?, ?, datetime('now'))
        `).run(userId, providerId, cleanUser, cleanEmail, passwordHash);
        try { require('./referrals').attach(userId, req.body && req.body.ref); } catch (e) {}

        const token = jwt.sign(
            { userId, username: cleanUser, isGuest: false },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.json({
            token,
            user: { id: userId, username: cleanUser, email: cleanEmail, isGuest: false }
        });
    } catch (err) {
        console.error('[Auth] Register error:', err);
        return res.status(500).json({ error: 'Failed to create user account.' });
    }
});

// -------------------------------------------------------------
// 2. LOGIN (SUPPORTS USERNAME OR EMAIL + REMEMBER ME)
// -------------------------------------------------------------
router.post('/login', async (req, res) => {
    const { username, password, rememberMe } = req.body;
    const identifier = (username || '').trim();

    if (!identifier || !password) {
        return res.status(400).json({ error: 'Please enter your username/email and password.' });
    }

    const user = typeof db.findUserByIdentifier === 'function'
        ? db.findUserByIdentifier(identifier)
        : db.findUserByUsername(identifier);

    if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    try {
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid username/email or password.' });
        }

        const tokenDuration = rememberMe ? '30d' : '1d';
        const token = jwt.sign(
            { userId: user.id, username: user.username, isGuest: false },
            JWT_SECRET,
            { expiresIn: tokenDuration }
        );

        return res.json({
            token,
            user: { id: user.id, username: user.username, email: user.email, isGuest: false }
        });
    } catch (err) {
        console.error('[Auth] Login error:', err);
        return res.status(500).json({ error: 'Internal login error.' });
    }
});

// -------------------------------------------------------------
// 3. PASSWORD RECOVERY: REQUEST RESET CODE (WITH EMAIL SENDER)
// -------------------------------------------------------------
router.post('/forgot-password', async (req, res) => {
    const { identifier } = req.body;
    if (!identifier) {
        return res.status(400).json({ error: 'Please enter your username or registered email.' });
    }

    const user = typeof db.findUserByIdentifier === 'function'
        ? db.findUserByIdentifier(identifier.trim())
        : db.findUserByUsername(identifier.trim());

    if (!user) {
        return res.json({ message: 'If an account exists with that identifier, a recovery code has been sent to the registered email.' });
    }

    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + 15 * 60 * 1000;

    if (typeof db.setResetToken === 'function') {
        db.setResetToken(user.id, resetCode, expiry);
    }

    console.log(`\n======================================================`);
    console.log(`[PASSWORD RECOVERY CODE] User: ${user.username} | Email: ${user.email}`);
    console.log(`CODE: ${resetCode} (Expires in 15 minutes)`);
    console.log(`======================================================\n`);

    if (!user.email) {
        return res.status(400).json({ error: 'This account does not have a recovery email linked.' });
    }

    try {
        await mailTransporter.sendMail({
            from: `"Blitz 31" <${SMTP_EMAIL}>`,
            to: user.email,
            subject: 'Your Blitz 31 Password Recovery Code',
            text: `Hello ${user.username},\n\nYour 6-digit password recovery code is: ${resetCode}\n\nThis code will expire in 15 minutes.\n\nIf you did not request a password reset, you can safely ignore this email.`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; background-color: #061c11; color: #f8fafc; border: 2px solid #d4af37; border-radius: 10px; text-align: center;">
                    <h2 style="color: #fbbf24; margin-top: 0;">Blitz 31 Password Recovery</h2>
                    <p style="color: #cbd5e1; font-size: 14px;">Hello <strong>${user.username}</strong>,</p>
                    <p style="color: #cbd5e1; font-size: 14px;">Enter the 6-digit recovery code below in the game to set a new password:</p>
                    <div style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #34d399; margin: 20px 0; padding: 14px; background: rgba(0, 0, 0, 0.45); border: 1px solid rgba(52, 211, 153, 0.4); border-radius: 8px;">
                        ${resetCode}
                    </div>
                    <p style="font-size: 12px; color: #94a3b8; margin-bottom: 0;">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
                </div>
            `
        });

        return res.json({
            message: 'Recovery code sent! Check your email inbox (and spam folder) for the 6-digit code.',
            userId: user.id
        });
    } catch (mailErr) {
        console.error('[Auth] Failed to send recovery email:', mailErr.message);
        return res.status(500).json({
            error: 'Failed to send recovery email. Please try again shortly.'
        });
    }
});

// -------------------------------------------------------------
// 4. PASSWORD RECOVERY: VERIFY CODE & SET NEW PASSWORD
// -------------------------------------------------------------
router.post('/reset-password', async (req, res) => {
    const { identifier, code, newPassword } = req.body;

    if (!identifier || !code || !newPassword) {
        return res.status(400).json({ error: 'All fields (account, code, and new password) are required.' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const user = typeof db.findUserByIdentifier === 'function'
        ? db.findUserByIdentifier(identifier.trim())
        : db.findUserByUsername(identifier.trim());

    if (!user) {
        return res.status(404).json({ error: 'Account not found.' });
    }

    const isValid = typeof db.verifyResetToken === 'function' && db.verifyResetToken(user.id, code.trim());
    if (!isValid) {
        return res.status(400).json({ error: 'Invalid or expired recovery code. Please request a new one.' });
    }

    try {
        const passwordHash = await bcrypt.hash(newPassword, 10);
        db.updatePassword(user.id, passwordHash);

        return res.json({ message: 'Password reset successfully! You can now log in with your new password.' });
    } catch (err) {
        console.error('[Auth] Password reset error:', err);
        return res.status(500).json({ error: 'Failed to update password.' });
    }
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
        const decoded = jwt.verify(token, JWT_SECRET);
        return res.json({
            user: {
                id: decoded.userId,
                username: decoded.username,
                isGuest: false
            }
        });
    } catch (err) {
        return res.status(401).json({ error: 'Session expired or invalid.' });
    }
});

// -------------------------------------------------------------
// 5B. ACCOUNT & DATA DELETION REQUEST (/auth/request-delete, used by accdelete.html)
// -------------------------------------------------------------
// Records the request in the console and emails the operator so it can be
// actioned (manually or via the admin portal) within the published 48h window.
// Deliberately does NOT delete immediately: the page is unauthenticated, so an
// identifier alone must never be enough to wipe someone else's account.
router.post('/request-delete', async (req, res) => {
    const identifier = String(req.body?.identifier || '').trim();
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);

    if (!identifier) {
        return res.status(400).json({ error: 'Username or email is required.' });
    }

    const user = typeof db.findUserByIdentifier === 'function'
        ? db.findUserByIdentifier(identifier)
        : db.findUserByUsername(identifier);

    console.log(`\n======================================================`);
    console.log(`[ACCOUNT DELETION REQUEST] Identifier: ${identifier}`);
    console.log(`Matched user: ${user ? `${user.username} (${user.id}, ${user.email || 'no email'})` : 'none'}`);
    if (reason) console.log(`Reason: ${reason}`);
    console.log(`======================================================\n`);

    try {
        await mailTransporter.sendMail({
            from: `"Blitz 31" <${SMTP_EMAIL}>`,
            to: SMTP_EMAIL,
            subject: `Blitz 31 account deletion request: ${identifier}`,
            text: [
                `A deletion request was submitted from accdelete.html.`,
                ``,
                `Identifier entered: ${identifier}`,
                `Matched account: ${user ? `${user.username} (id ${user.id}, email ${user.email || 'n/a'})` : 'no matching account'}`,
                `Reason: ${reason || '(none given)'}`,
                `Submitted: ${new Date().toISOString()}`,
                ``,
                `Process via admin.html -> Registered Players -> Delete.`
            ].join('\n')
        });
    } catch (mailErr) {
        // Email is best-effort; the console log above is the fallback record
        console.error('[Auth] Failed to email deletion request:', mailErr.message);
    }

    // Always respond generically so the form can't be used to probe which accounts exist
    return res.json({ message: 'Deletion request received. Matching records will be removed within 48 hours.' });
});

// =============================================================
// 6. DEVELOPER & ADMIN CONTROL PANEL ROUTES (/auth/admin/*)
// =============================================================
const ADMIN_USERNAME = config.ADMIN_USERNAME;
const ADMIN_PASSWORD = config.ADMIN_PASSWORD;

function requireAdminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Admin authorization required.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded || !decoded.isAdmin) {
            return res.status(403).json({ error: 'Forbidden: Not an admin token.' });
        }
        // Tokens issued to database accounts are re-checked on every call so that
        // revoking admin (or deleting the account) takes effect immediately.
        if (decoded.userId) {
            const row = sqlDb.prepare('SELECT is_admin FROM users WHERE id = ?').get(decoded.userId);
            if (!row || Number(row.is_admin) !== 1) {
                return res.status(403).json({ error: 'Admin access has been revoked for this account.' });
            }
        }
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Admin session expired or invalid.' });
    }
}

// Helper to push updated Lifetime Ledger balances to any online players
function pushLiveLifetimeUpdate(userId) {
    if (!userId || typeof db.getLifetimeBalances !== 'function') return;
    const balances = db.getLifetimeBalances(userId) || [];
    const payload = JSON.stringify({
        type: 'LIFETIME_LEDGER_DATA',
        balances,
        ledger: balances,
        debts: balances
    });

    Object.values(lobbies || {}).forEach(lob => {
        [...(lob.players || []).map(p => p.id), ...(lob.spectators || []).map(s => s.idSocket)].forEach(sock => {
            if (sock && sock.readyState === WebSocket.OPEN && String(sock.userId) === String(userId)) {
                try { sock.send(payload); } catch (e) {}
            }
        });
    });
}

// 6A. Secret Admin Login
// Two ways in: the secret ADMIN_USERNAME/ADMIN_PASSWORD from .env, or any registered
// account (username or email + its normal password) whose users.is_admin = 1.
const adminLoginFails = new Map(); // ip -> { count, resetAt }
const ADMIN_LOGIN_MAX_FAILS = 10;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;

// One-tap admin sign-in from the game: an admin account that is signed in to the game exchanges its game
// session for a 12 h admin token (same as signing in on admin.html; is_admin is still re-checked on every call).
router.post('/admin/sso', (req, res) => {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in to the game first.' });
    let d = null;
    try { d = jwt.verify(h.slice(7), JWT_SECRET); } catch (e) { return res.status(401).json({ error: 'Game session expired. Sign in again.' }); }
    const uid = d && (d.userId || d.id);
    if (!uid || d.isAdmin) return res.status(400).json({ error: 'Use a game session.' });
    const row = sqlDb.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(String(uid));
    if (!row || Number(row.is_admin) !== 1) return res.status(403).json({ error: 'This account is not an admin.' });
    const token = jwt.sign({ isAdmin: true, userId: row.id, username: row.username }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ token, username: row.username });
});

// Growth dashboard numbers (server/adminMetrics.js)
router.get('/admin/metrics', requireAdminAuth, (req, res) => {
    try {
        let lm = null; try { lm = require('./game/lobbyManager'); } catch (e) {}
        res.set('Cache-Control', 'no-store');
        return res.json(require('./adminMetrics').compute(lm));
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/admin/login', async (req, res) => {
    const { username, password } = req.body || {};
    const ip = clientIp(req); // behind Caddy req.ip is always 127.0.0.1
    const now = Date.now();

    let rec = adminLoginFails.get(ip);
    if (rec && now > rec.resetAt) { adminLoginFails.delete(ip); rec = null; }
    if (rec && rec.count >= ADMIN_LOGIN_MAX_FAILS) {
        return res.status(429).json({ error: 'Too many failed admin sign-ins. Try again in 15 minutes.' });
    }

    const identifier = String(username || '').trim();
    const pass = String(password || '');

    if (identifier && pass) {
        // 1) Secret .env admin
        if (identifier === ADMIN_USERNAME && pass === ADMIN_PASSWORD) {
            adminLoginFails.delete(ip);
            const token = jwt.sign(
                { isAdmin: true, username: ADMIN_USERNAME },
                JWT_SECRET,
                { expiresIn: '12h' }
            );
            return res.json({ token });
        }

        // 2) Registered account flagged as admin in SQLite
        try {
            const user = typeof db.findUserByIdentifier === 'function'
                ? db.findUserByIdentifier(identifier)
                : db.findUserByUsername(identifier);
            if (user && user.password_hash && await bcrypt.compare(pass, user.password_hash)) {
                const row = sqlDb.prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id);
                if (row && Number(row.is_admin) === 1) {
                    adminLoginFails.delete(ip);
                    const token = jwt.sign(
                        { isAdmin: true, userId: user.id, username: user.username },
                        JWT_SECRET,
                        { expiresIn: '12h' }
                    );
                    return res.json({ token });
                }
            }
        } catch (err) {
            console.error('[Admin Login Error]:', err);
            return res.status(500).json({ error: 'Internal admin login error.' });
        }
    }

    const next = rec || { count: 0, resetAt: now + ADMIN_LOGIN_WINDOW_MS };
    next.count += 1;
    adminLoginFails.set(ip, next);
    return res.status(401).json({ error: 'Invalid admin username/email or password.' });
});

// 6B. Overview Snapshot (Users, Lifetime Ledger, Live Lobbies)
router.get('/admin/overview', requireAdminAuth, (req, res) => {
    try {
        let users = [];
        try {
            users = sqlDb.prepare(`SELECT id, provider, username, email, created_at, COALESCE(is_admin, 0) AS is_admin, COALESCE(is_premium, 0) AS is_premium, trial_until, premium_until FROM users WHERE COALESCE(provider, 'local') != 'guest' ORDER BY created_at DESC`).all();
        } catch (e) {
            users = sqlDb.prepare(`SELECT id, provider, username, created_at FROM users WHERE COALESCE(provider, 'local') != 'guest' ORDER BY created_at DESC`).all();
        }
        // invites: how many accounts each user brought in / got rewarded for (server/referrals.js)
        try {
            const inv = {};
            sqlDb.prepare('SELECT referred_by id, COUNT(*) n, SUM(CASE WHEN ref_rewarded = 1 THEN 1 ELSE 0 END) r FROM users WHERE referred_by IS NOT NULL GROUP BY referred_by').all()
                .forEach(x => { inv[x.id] = { n: x.n, r: x.r || 0 }; });
            users.forEach(u => { u.invited = (inv[u.id] || {}).n || 0; u.invitedRewarded = (inv[u.id] || {}).r || 0; });
        } catch (e) {}
        // which recorded cues each user has (server/cues.js)
        try {
            const cues = {};
            sqlDb.prepare('SELECT user_id, kind FROM user_cues').all().forEach(r => { (cues[r.user_id] = cues[r.user_id] || []).push(r.kind); });
            users.forEach(u => { u.cues = cues[u.id] || []; });
        } catch (e) { users.forEach(u => { u.cues = []; }); }

        const ledger = sqlDb.prepare(`
            SELECT 
                l.debtor_id,
                u1.username AS debtor_name,
                l.creditor_id,
                u2.username AS creditor_name,
                l.amount,
                l.updated_at
            FROM lifetime_ledger l
            LEFT JOIN users u1 ON u1.id = l.debtor_id
            LEFT JOIN users u2 ON u2.id = l.creditor_id
            WHERE l.amount > 0.005
            ORDER BY l.updated_at DESC
        `).all();

        const liveLobbies = Object.values(lobbies || {}).map(l => ({
            code: l.code,
            name: l.name,
            host: l.host,
            gameState: l.gameState,
            players: (l.players || []).map(p => ({
                username: p.username,
                accountUsername: p.accountUsername,
                lives: p.lives,
                wager: p.wager,
                isBot: !!p.isBot,
                online: Boolean(p.isBot || (p.id && p.id.readyState === WebSocket.OPEN))
            })),
            spectators: (l.spectators || []).map(s => ({
                username: s.username,
                online: Boolean(s.idSocket && s.idSocket.readyState === WebSocket.OPEN)
            }))
        }));

        return res.json({ users, ledger, lobbies: liveLobbies });
    } catch (err) {
        console.error('[Admin Overview Error]:', err);
        return res.status(500).json({ error: err.message });
    }
});

// 6C. Set, Edit, or Add Lifetime Balance
router.post('/admin/balance', requireAdminAuth, (req, res) => {
    const { debtorId, creditorId, amount, mode } = req.body;
    const cleanAmt = Number(amount);

    if (!debtorId || !creditorId || debtorId === creditorId || isNaN(cleanAmt) || cleanAmt < 0) {
        return res.status(400).json({ error: 'Invalid debtor, creditor, or amount.' });
    }

    try {
        if (mode === 'add') {
            if (cleanAmt > 0 && typeof db.recordLifetimeDebt === 'function') {
                db.recordLifetimeDebt(debtorId, creditorId, cleanAmt);
            }
        } else {
            // 'set' mode: Clear both directions between the pair and set exact net balance
            sqlDb.prepare(`
                DELETE FROM lifetime_ledger 
                WHERE (debtor_id = ? AND creditor_id = ?) 
                   OR (debtor_id = ? AND creditor_id = ?)
            `).run(debtorId, creditorId, creditorId, debtorId);

            if (cleanAmt > 0.005) {
                sqlDb.prepare(`
                    INSERT INTO lifetime_ledger (debtor_id, creditor_id, amount, updated_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                `).run(debtorId, creditorId, cleanAmt);
            }
        }

        pushLiveLifetimeUpdate(debtorId);
        pushLiveLifetimeUpdate(creditorId);

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 6D. Wipe All Lifetime Balances
router.post('/admin/balance/wipe-all', requireAdminAuth, (req, res) => {
    try {
        sqlDb.prepare(`DELETE FROM lifetime_ledger`).run();
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 6E. User Management (Update Info, Reset Password, Create, Delete)
router.post('/admin/user/update', requireAdminAuth, (req, res) => {
    const { userId, username, email } = req.body;
    if (!userId || !username) return res.status(400).json({ error: 'userId and username are required.' });
    { const nameErr = usernameProblem(String(username).trim()); if (nameErr) return res.status(400).json({ error: nameErr }); }

    try {
        sqlDb.prepare(`UPDATE users SET username = ?, email = ? WHERE id = ?`)
             .run(username.trim(), (email || '').trim().toLowerCase() || null, userId);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/admin/user/password', requireAdminAuth, async (req, res) => {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'Valid userId and password (min 6 chars) required.' });
    }

    try {
        const hash = await bcrypt.hash(newPassword, 10);
        sqlDb.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, userId);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/admin/user/create', requireAdminAuth, async (req, res) => {
    const { username, email, password } = req.body;
    const cleanUser = (username || '').trim();
    { const nameErr = usernameProblem(cleanUser); if (nameErr) return res.status(400).json({ error: nameErr }); }
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanUser || !password || password.length < 6) {
        return res.status(400).json({ error: 'Username and password (min 6 chars) required.' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        const providerId = `local_${cleanUser.toLowerCase()}`;

        sqlDb.prepare(`
            INSERT INTO users (id, provider, provider_id, username, email, password_hash, created_at)
            VALUES (?, 'local', ?, ?, ?, ?, datetime('now'))
        `).run(userId, providerId, cleanUser, cleanEmail || null, passwordHash);

        return res.json({ success: true, userId });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Grant or revoke panel access for a registered account
router.post('/admin/user/admin', requireAdminAuth, (req, res) => {
    const { userId, isAdmin } = req.body;
    if (!userId || typeof isAdmin !== 'boolean') {
        return res.status(400).json({ error: 'userId and isAdmin (true/false) required.' });
    }
    if (!isAdmin && req.admin && req.admin.userId === userId) {
        return res.status(400).json({ error: 'You cannot remove your own admin access.' });
    }
    try {
        const info = sqlDb.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
        if (!info.changes) return res.status(404).json({ error: 'User not found.' });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Grant or revoke Premium (cosmetics). Admin accounts always have it.
router.post('/admin/user/premium', requireAdminAuth, (req, res) => {
    const { userId, isPremium } = req.body;
    if (!userId || typeof isPremium !== 'boolean') {
        return res.status(400).json({ error: 'userId and isPremium (true/false) required.' });
    }
    try {
        const info = sqlDb.prepare('UPDATE users SET is_premium = ? WHERE id = ?').run(isPremium ? 1 : 0, userId);
        if (!info.changes) return res.status(404).json({ error: 'User not found.' });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Recorded cues: listen to and remove a player's recordings
function scrubLiveCues(userId, kinds) {
    // live sockets of that user stop advertising the removed recording to their table
    try {
        const wss = global.blitz31Wss;
        if (!wss || !wss.clients) return;
        wss.clients.forEach(ws => {
            if (!ws || String(ws.userId) !== String(userId) || !ws.__cel) return;
            if (kinds.includes('knock') && ws.__cel.knock === 'rec') { ws.__cel.knock = 'default'; delete ws.__cel.knockCue; }
            if (kinds.includes('win')) {
                if (ws.__cel.win === 'rec') ws.__cel.win = 'default';
                if (ws.__cel.hit31 === 'rec') ws.__cel.hit31 = 'default';
                delete ws.__cel.winCue;
            }
        });
    } catch (e) {}
}
router.get('/admin/user/cue', requireAdminAuth, (req, res) => {
    const userId = String(req.query.userId || ''), kind = String(req.query.kind || '');
    if (!userId || !['knock', 'win'].includes(kind)) return res.status(400).json({ error: 'userId and kind required.' });
    try {
        const r = sqlDb.prepare('SELECT mime, data FROM user_cues WHERE user_id = ? AND kind = ?').get(userId, kind);
        if (!r) return res.status(404).json({ error: 'No recording.' });
        res.set('Content-Type', r.mime); res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff');
        return res.send(Buffer.from(r.data));
    } catch (err) { return res.status(500).json({ error: err.message }); }
});
router.post('/admin/user/cues/delete', requireAdminAuth, (req, res) => {
    const { userId, kind } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required.' });
    const kinds = ['knock', 'win'].includes(kind) ? [kind] : ['knock', 'win'];
    try {
        let n = 0;
        kinds.forEach(k => { n += sqlDb.prepare('DELETE FROM user_cues WHERE user_id = ? AND kind = ?').run(userId, k).changes; });
        scrubLiveCues(userId, kinds);
        return res.json({ success: true, removed: n });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/admin/user/delete', requireAdminAuth, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required.' });
    if (req.admin && req.admin.userId === userId) {
        return res.status(400).json({ error: 'You cannot delete the account you are signed in with.' });
    }

    try {
        sqlDb.prepare(`DELETE FROM lifetime_ledger WHERE debtor_id = ? OR creditor_id = ?`).run(userId, userId);
        try { sqlDb.prepare('DELETE FROM user_cues WHERE user_id = ?').run(userId); scrubLiveCues(userId, ['knock', 'win']); } catch (e) {}
        sqlDb.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 6F. Live Lobby Actions (Reset Match, Clear Session Ledger, Kick Player, Close Table)
router.post('/admin/lobby/action', requireAdminAuth, (req, res) => {
    const { code, action, targetUsername } = req.body;
    const lobby = lobbies && lobbies[code];
    if (!lobby) return res.status(404).json({ error: 'Lobby not found.' });

    try {
        if (action === 'reset') {
            if (typeof resetLobbyToReadyRoom === 'function') {
                resetLobbyToReadyRoom(lobby, '🛠️ Admin reset the table to the waiting room.');
            } else {
                lobby.gameState = 'lobby';
                lobby.players.forEach(p => { p.ready = false; p.eliminated = false; p.cards = []; });
                broadcastLobbyUpdate(lobby.code);
            }
        } else if (action === 'clear_session_ledger') {
            lobby.mainGameLedger = {};
            lobby.sideBetLedger = {};
            lobby.botBetLedger = {};
            lobby.ledgerHistory = [];
            broadcastLobbyUpdate(lobby.code);
        } else if (action === 'kick' && targetUsername) {
            const tLower = targetUsername.toLowerCase();
            const pIdx = (lobby.players || []).findIndex(p => p.username && p.username.toLowerCase() === tLower);
            if (pIdx !== -1) {
                const removed = lobby.players.splice(pIdx, 1)[0];
                if (removed.id && typeof removed.id === 'object' && removed.id.readyState === WebSocket.OPEN) {
                    removed.id.send(JSON.stringify({ type: 'KICKED_FROM_LOBBY', message: 'Removed by Admin.' }));
                }
                lobby.players.forEach((p, idx) => { p.seat = idx; });
            }
            broadcastLobbyUpdate(lobby.code);
        } else if (action === 'close') {
            [...(lobby.players || []).map(p => p.id), ...(lobby.spectators || []).map(s => s.idSocket)].forEach(sock => {
                if (sock && typeof sock === 'object' && sock.readyState === WebSocket.OPEN) {
                    try { sock.send(JSON.stringify({ type: 'KICKED_FROM_LOBBY', message: 'Table closed by Admin.' })); } catch (e) {}
                }
            });
            delete lobbies[code];
        }

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 6G. Global Broadcast Banner to All Active Lobbies
router.post('/admin/broadcast', requireAdminAuth, (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });

    const payload = JSON.stringify({
        type: 'NOTIFICATION',
        message: `📢 ADMIN: ${String(message).trim()}`
    });

    Object.values(lobbies || {}).forEach(lob => {
        [...(lob.players || []).map(p => p.id), ...(lob.spectators || []).map(s => s.idSocket)].forEach(sock => {
            if (sock && typeof sock === 'object' && sock.readyState === WebSocket.OPEN) {
                try { sock.send(payload); } catch (e) {}
            }
        });
    });

    return res.json({ success: true });
});

// 6H. Raw SQLite Developer Query Runner
router.post('/admin/sql', requireAdminAuth, (req, res) => {
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: 'SQL query required.' });

    try {
        const trimmed = sql.trim();
        const isReader = /^(SELECT|PRAGMA|EXPLAIN)/i.test(trimmed);
        const stmt = sqlDb.prepare(trimmed);
        if (isReader) {
            const rows = stmt.all();
            return res.json({ rows });
        } else {
            const info = stmt.run();
            return res.json({ changes: info.changes, lastInsertRowid: info.lastInsertRowid });
        }
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

module.exports = router;
