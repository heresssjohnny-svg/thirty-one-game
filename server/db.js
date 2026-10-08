// server/db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data.sqlite is created in the project root directory
const rootDir = fs.existsSync(path.join(__dirname, '..', 'package.json')) 
    ? path.join(__dirname, '..') 
    : __dirname;
const dbPath = path.join(rootDir, 'data.sqlite');

const db = new Database(dbPath);

// Enable Write-Ahead Logging for high concurrency and speed
db.pragma('journal_mode = WAL');

// Initialize schema for accounts and persistent pairwise debt
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,          -- 'local', 'google', 'facebook', 'instagram'
    provider_id TEXT UNIQUE,        -- Provider UID, sub, or lowercase email
    username TEXT NOT NULL,
    password_hash TEXT,             -- NULL for OAuth social logins
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

module.exports = {
  db,

  // --- USER LOOKUP & CREATION ---

  findUserByProviderId: (providerId) => {
    if (!providerId) return null;
    return db.prepare('SELECT * FROM users WHERE provider_id = ?').get(providerId.toLowerCase());
  },

  findUserById: (id) => {
    if (!id) return null;
    return db.prepare('SELECT id, provider, username, created_at FROM users WHERE id = ?').get(id);
  },

  // Lookup by username (case-insensitive) to bridge session ledger usernames to SQLite IDs
  findUserByUsername: (username) => {
    if (!username) return null;
    return db.prepare('SELECT id, provider, username, created_at FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
  },

  createUser: (id, provider, providerId, username, passwordHash = null) => {
    db.prepare(`
      INSERT INTO users (id, provider, provider_id, username, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, provider, providerId.toLowerCase(), username.trim(), passwordHash);
    return { id, provider, provider_id: providerId.toLowerCase(), username: username.trim() };
  },

  // --- LIFETIME LEDGER OPERATIONS ---

  /**
   * Records that debtorId owes creditorId a given amount.
   * Automatically calculates reverse debt to net balances out.
   */
  recordLifetimeDebt: (debtorId, creditorId, amount) => {
    if (!debtorId || !creditorId || debtorId === creditorId || amount <= 0) return;

    // Check if the creditor currently owes the debtor money (reverse debt)
    const reverse = db.prepare(`
      SELECT amount FROM lifetime_ledger WHERE debtor_id = ? AND creditor_id = ?
    `).get(creditorId, debtorId);

    if (reverse) {
      if (reverse.amount > amount) {
        // Reverse debt is larger: decrease creditor's existing debt
        db.prepare(`
          UPDATE lifetime_ledger 
          SET amount = amount - ?, updated_at = CURRENT_TIMESTAMP 
          WHERE debtor_id = ? AND creditor_id = ?
        `).run(amount, creditorId, debtorId);
        return;
      } else if (reverse.amount === amount) {
        // Reverse debt exactly equals this amount: fully settled
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
   * Retrieves all net balances for a user:
   *  +net means the other player owes this user.
   *  -net means this user owes the other player.
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
   * Allows a creditor to mark an amount as paid/credited towards a player who owes them.
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
      // Wiped clear
      db.prepare(`
        DELETE FROM lifetime_ledger WHERE debtor_id = ? AND creditor_id = ?
      `).run(debtorId, creditorId);
      return { success: true, remaining: 0 };
    } else {
      // Partial credit reduction
      db.prepare(`
        UPDATE lifetime_ledger 
        SET amount = amount - ?, updated_at = CURRENT_TIMESTAMP 
        WHERE debtor_id = ? AND creditor_id = ?
      `).run(creditAmount, debtorId, creditorId);
      return { success: true, remaining: entry.amount - creditAmount };
    }
  }
};
