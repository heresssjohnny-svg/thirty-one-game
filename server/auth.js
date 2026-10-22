// server/auth.js - Local Email-Linked Authentication & Password Recovery
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('./db');
const config = require('./config');

const JWT_SECRET = (config && config.JWT_SECRET) || process.env.JWT_SECRET || 'blitz31_fallback_super_secret_jwt_key_2026';

// -------------------------------------------------------------
// EMAIL / SMTP CONFIGURATION
// -------------------------------------------------------------
const SMTP_EMAIL = (config && config.SMTP_EMAIL) || process.env.SMTP_EMAIL || 'heresssjohnny@gmail.com';
const SMTP_PASSWORD = (config && config.SMTP_PASSWORD) || process.env.SMTP_PASSWORD || 'ybsg sbmt dctc soqj';

const mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: SMTP_EMAIL,
        pass: SMTP_PASSWORD.replace(/\s+/g, '') // Strips spaces automatically -> ybsgsbmtdctcsoqj
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

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!cleanEmail || !emailRegex.test(cleanEmail)) {
        return res.status(400).json({ error: 'A valid email address is required for password recovery.' });
    }

    if (db.findUserByUsername(cleanUser)) {
        return res.status(409).json({ error: 'Username is already taken.' });
    }

    if (db.findUserByEmail(cleanEmail)) {
        return res.status(409).json({ error: 'This email is already registered.' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        const providerId = `local_${cleanUser.toLowerCase()}`;

        // Create user with linked email
        db.prepare(`
            INSERT INTO users (id, provider, provider_id, username, email, password_hash, created_at)
            VALUES (?, 'local', ?, ?, ?, ?, datetime('now'))
        `).run(userId, providerId, cleanUser, cleanEmail, passwordHash);

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

    const user = db.findUserByIdentifier(identifier);
    if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    try {
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid username/email or password.' });
        }

        // Token lifetime: 30 days if Remember Me is checked, otherwise 1 day
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

    const user = db.findUserByIdentifier(identifier.trim());
    if (!user) {
        // Obscure user enumeration for security
        return res.json({ message: 'If an account exists with that identifier, a recovery code has been sent to the registered email.' });
    }

    // Generate 6-digit numeric recovery code valid for 15 minutes
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + 15 * 60 * 1000;

    db.setResetToken(user.id, resetCode, expiry);

    // Logs the reset PIN to the terminal / PM2 logs as a backup
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

        console.log(`[Auth] Recovery email successfully sent to ${user.email}`);
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

    const user = db.findUserByIdentifier(identifier.trim());
    if (!user) {
        return res.status(404).json({ error: 'Account not found.' });
    }

    const isValid = db.verifyResetToken(user.id, code.trim());
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

module.exports = router;
