// server/db.js - SQLite Database, Local Authentication & Lifetime Ledger
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Resolve database file to the persistent project root
const rootDir = fs.existsSync(path.join(__dirname, '..', 'package.json'))
    ? path.join(__dirname, '..')
    : __dirname;
const dbPath = path.join(rootDir, 'data.sqlite');

const db = new Database(dbPath);

// Enable Write-Ahead Logging for high concurrency
db.pragma('journal_mode = WAL');

// -------------------------------------------------------------
// 1. SCHEMA DEFINITION & SAFE MIGRATIONS
// -------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    provider TEXT DEFAULT 'local',
    provider_id TEXT UNIQUE,
    username TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    reset_token TEXT,
    reset_expiry INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lifetime_ledger (
    debtor_id TEXT NOT NULL,
    creditor_id TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (debtor_id, creditor_id),
    FOREIGN KEY(debtor_id) REFERENCES users(id),
    FOREIGN KEY(creditor_id) REFERENCES users(id)
  );
`);

// Apply column migrations if an existing database file is present on disk
try { db.prepare('ALTER TABLE users ADD COLUMN email TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE users ADD COLUMN reset_token TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE users ADD COLUMN reset_expiry INTEGER').run(); } catch (e) {}

// -------------------------------------------------------------
// 2. USER LOOKUP, REGISTRATION & PASSWORD RECOVERY
// -------------------------------------------------------------
module.exports = {
  db,
  prepare: (...args) => db.prepare(...args),
  exec: (...args) => db.exec(...args),

  // Lookup by identifier (allows logging in via username OR email)
  findUserByIdentifier: (identifier) => {
    if (!identifier) return null;
    const clean = identifier.trim().toLowerCase();
    return db.prepare(`
      SELECT id, username, email, password_hash, reset_token, reset_expiry, created_at 
      FROM users 
      WHERE LOWER(username) = ? OR LOWER(email) = ?
      LIMIT 1
    `).get(clean, clean);
  },

  // Lookup by username
  findUserByUsername: (username) => {
    if (!username) return null;
    return db.prepare(`
      SELECT id, username, email, password_hash, reset_token, reset_expiry, created_at 
      FROM users 
      WHERE LOWER(username) = LOWER(?)
      LIMIT 1
    `).get(username.trim());
  },

  // Lookup by recovery email
  findUserByEmail: (email) => {
    if (!email) return null;
    return db.prepare(`
      SELECT id, username, email, password_hash, reset_token, reset_expiry, created_at 
      FROM users 
      WHERE LOWER(email) = LOWER(?)
      LIMIT 1
    `).get(email.trim());
  },

  // Lookup by user ID
  findUserById: (id) => {
    if (!id) return null;
    return db.prepare(`
      SELECT id, username, email, created_at 
      FROM users 
      WHERE id = ?
    `).get(id);
  },

  // Create local user linked to mandatory email
  createUser: (id, username, email, passwordHash) => {
    const cleanUser = username.trim();
    const cleanEmail = email.trim().toLowerCase();
    const providerId = `local_${cleanUser.toLowerCase()}`;

    db.prepare(`
      INSERT INTO users (id, provider, provider_id, username, email, password_hash, created_at)
      VALUES (?, 'local', ?, ?, ?, ?, datetime('now'))
    `).run(id, providerId, cleanUser, cleanEmail, passwordHash);

    return { id, username: cleanUser, email: cleanEmail };
  },

  // Save 6-digit recovery code and expiration timestamp
  setResetToken: (userId, token, expiry) => {
    return db.prepare(`
      UPDATE users 
      SET reset_token = ?, reset_expiry = ? 
      WHERE id = ?
    `).run(token, expiry, userId);
  },

  // Verify recovery code validity and expiry window
  verifyResetToken: (userId, token) => {
    const user = db.prepare('SELECT id, reset_token, reset_expiry FROM users WHERE id = ?').get(userId);
    if (!user || !user.reset_token || user.reset_token !== token) return false;
    if (Date.now() > user.reset_expiry) return false;
    return true;
  },

  // Update password and invalidate used reset token
  updatePassword: (userId, newPasswordHash) => {
    return db.prepare(`
      UPDATE users 
      SET password_hash = ?, reset_token = NULL, reset_expiry = NULL 
      WHERE id = ?
    `).run(newPasswordHash, userId);
  },

  // -------------------------------------------------------------
  // 3. LIFETIME LEDGER & BILATERAL NETTING OPERATIONS
  // -------------------------------------------------------------

  /**
   * Records that debtorId owes creditorId an amount.
   * Nets balances out if the creditor already owes the debtor.
   */
  recordLifetimeDebt: (debtorId, creditorId, amount) => {
    if (!debtorId || !creditorId || debtorId === creditorId || amount <= 0) return;

    // Check if the opposite debt exists (creditor owes debtor)
    const reverse = db.prepare(`
      SELECT amount FROM lifetime_ledger WHERE debtor_id = ? AND creditor_id = ?
    `).get(creditorId, debtorId);

    if (reverse) {
      if (reverse.amount > amount) {
        // Reverse debt is larger: deduct from creditor's existing debt
        db.prepare(`
          UPDATE lifetime_ledger 
          SET amount = amount - ?, updated_at = CURRENT_TIMESTAMP 
          WHERE debtor_id = ? AND creditor_id = ?
        `).run(amount, creditorId, debtorId);
        return;
      } else if (reverse.amount === amount) {
        // Both debts cancel out completely
        db.prepare(`
          DELETE FROM lifetime_ledger WHERE debtor_id = ? AND creditor_id = ?
        `).run(creditorId, debtorId);
        return;
      } else {
        // New debt exceeds the reverse debt: eliminate reverse row and record remainder
        const remaining = amount - reverse.amount;
        db.prepare(`
          DELETE FROM lifetime_ledger WHERE debtor_id = ? AND creditor_id = ?
        `).run(creditorId, debtorId);

        db.prepare(`
          INSERT INTO lifetime_ledger (debtor_id, creditor_id, amount)
          VALUES (?, ?, ?)
          ON CONFLICT(debtor_id, creditor_id) DO UPDATE 
            SET amount = amount + excluded.amount, updated_at = CURRENT_TIMESTAMP
        `).run(debtorId, creditorId, remaining);
        return;
      }
    }

    // No existing reverse debt: add or increment debt directly
    db.prepare(`
      INSERT INTO lifetime_ledger (debtor_id, creditor_id, amount)
      VALUES (?, ?, ?)
      ON CONFLICT(debtor_id, creditor_id) DO UPDATE 
        SET amount = amount + excluded.amount, updated_at = CURRENT_TIMESTAMP
    `).run(debtorId, creditorId, amount);
  },

  /**
   * Retrieves bilateral net balances for a user:
   *  +net: Other player owes this user
   *  -net: This user owes the other player
   */
  getLifetimeBalances: (userId) => {
    if (!userId) return [];

    // Players who owe this user (User is Creditor)
    const debtors = db.prepare(`
      SELECT l.debtor_id AS other_id, u.username, l.amount AS net
      FROM lifetime_ledger l
      JOIN users u ON u.id = l.debtor_id
      WHERE l.creditor_id = ? AND l.amount > 0
    `).all(userId);

    // Players this user owes (User is Debtor)
    const creditors = db.prepare(`
      SELECT l.creditor_id AS other_id, u.username, (-l.amount) AS net
      FROM lifetime_ledger l
      JOIN users u ON u.id = l.creditor_id
      WHERE l.debtor_id = ? AND l.amount > 0
    `).all(userId);

    return [...debtors, ...creditors];
  },

  /**
   * Clears or partially credits an outstanding balance.
   */
  applyCredit: (creditorId, debtorId, creditAmount) => {
    if (!creditorId || !debtorId || creditAmount <= 0) {
      return { success: false, error: 'Invalid credit parameters.' };
    }

    const entry = db.prepare(`
      SELECT amount FROM lifetime_ledger WHERE debtor_id = ? AND creditor_id = ?
    `).get(debtorId, creditorId);

    if (!entry || entry.amount <= 0) {
      return { success: false, error: 'No outstanding debt owed by this player.' };
    }

    if (creditAmount >= entry.amount) {
      db.prepare(`
        DELETE FROM lifetime_ledger WHERE debtor_id = ? AND creditor_id = ?
      `).run(debtorId, creditorId);
      return { success: true, remaining: 0 };
    } else {
      db.prepare(`
        UPDATE lifetime_ledger 
        SET amount = amount - ?, updated_at = CURRENT_TIMESTAMP 
        WHERE debtor_id = ? AND creditor_id = ?
      `).run(creditAmount, debtorId, creditorId);
      return { success: true, remaining: entry.amount - creditAmount };
    }
  }
};
