// server/throwables.js - extra throwables that are admin-only unless an admin turns them on for a player.
// The 12 regular emotes stay Premium (server/emotes.js). Everything in CATALOG:
//   - admin accounts can always throw it;
//   - other players only after an admin switches it on for them (admin panel → Users → 🎯 Throwables).
// New throwables go in CATALOG and are admin-only until granted. 'img:<name>' = public/img/throw/<name>.png.
// Table user_throwables (user_id, emote) holds the grants. TheMan's three (🍆 💦 img:toy) were moved here once.
const db = require('./db');
const sql = typeof db.prepare === 'function' ? db : db.db;

const CATALOG = [
    { id: '🍆', label: 'Eggplant' },
    { id: '💦', label: 'Splash' },
    { id: 'img:toy', label: 'Toy (picture)' },
    { id: 'img:baby', label: 'Baby (picture)' },
    { id: '🖕', label: 'Middle finger' },
    { id: 'img:bye', label: 'Bye! (word)' }
];
const IDS = CATALOG.map(c => c.id);

sql.exec(`CREATE TABLE IF NOT EXISTS user_throwables (
  user_id TEXT NOT NULL, emote TEXT NOT NULL, granted_by TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, emote));
  CREATE TABLE IF NOT EXISTS throwable_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL);`);

// one-time: TheMan used to get 🍆 💦 img:toy by name (PR #75-#79); give him the same grants
try {
    if (!sql.prepare("SELECT 1 FROM throwable_migrations WHERE name = 'theman'").get()) {
        const row = sql.prepare("SELECT id FROM users WHERE LOWER(username) = 'theman' AND COALESCE(provider, 'local') != 'guest' LIMIT 1").get();
        if (row) {
            const ins = sql.prepare('INSERT OR IGNORE INTO user_throwables (user_id, emote, granted_by, created_at) VALUES (?, ?, ?, ?)');
            ['🍆', '💦', 'img:toy'].forEach(e => ins.run(String(row.id), e, 'migration', Date.now()));
        }
        sql.prepare("INSERT INTO throwable_migrations (name, at) VALUES ('theman', ?)").run(Date.now());
    }
} catch (e) { console.error('[throwables] migration failed', e.message); }

const isGuest = (id) => !id || String(id).startsWith('gst_') || String(id).startsWith('usr_guest_');
function isAdminUser(userId) {
    try { const r = sql.prepare('SELECT is_admin FROM users WHERE id = ?').get(String(userId)); return !!(r && Number(r.is_admin) === 1); }
    catch (e) { return false; }
}
function grantsFor(userId) {
    if (isGuest(userId)) return [];
    try { return sql.prepare('SELECT emote FROM user_throwables WHERE user_id = ?').all(String(userId)).map(r => r.emote).filter(e => IDS.includes(e)); }
    catch (e) { return []; }
}
// the catalog throwables this player may throw, in catalog order
function allowedFor(userId) {
    if (isGuest(userId)) return [];
    if (isAdminUser(userId)) return IDS.slice();
    const g = new Set(grantsFor(userId));
    return IDS.filter(id => g.has(id));
}
function canThrow(userId, emote) { return IDS.includes(emote) && allowedFor(userId).includes(emote); }
function setGrant(userId, emote, on, by) {
    if (!IDS.includes(emote)) throw new Error('Unknown throwable.');
    if (on) sql.prepare('INSERT OR IGNORE INTO user_throwables (user_id, emote, granted_by, created_at) VALUES (?, ?, ?, ?)').run(String(userId), emote, by || 'admin', Date.now());
    else sql.prepare('DELETE FROM user_throwables WHERE user_id = ? AND emote = ?').run(String(userId), emote);
}
function allGrants() {
    const out = {};
    try { sql.prepare('SELECT user_id, emote FROM user_throwables').all().forEach(r => { if (IDS.includes(r.emote)) (out[r.user_id] = out[r.user_id] || []).push(r.emote); }); } catch (e) {}
    return out;
}
// tell that player's open games right away so the throw menu updates without a reload
function notifyUser(userId) {
    try {
        const wss = global.blitz31Wss;
        if (!wss || !wss.clients) return;
        const body = JSON.stringify({ type: 'THROWABLES', list: allowedFor(userId) });
        wss.clients.forEach(ws => { if (ws && ws.readyState === 1 && String(ws.userId) === String(userId)) { try { ws.send(body); } catch (e) {} } });
    } catch (e) {}
}

module.exports = { CATALOG, IDS, allowedFor, canThrow, setGrant, grantsFor, allGrants, notifyUser };
