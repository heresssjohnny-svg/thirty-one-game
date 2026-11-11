// server/paymentClaims.js - "I paid you" claims survive until the creditor answers.
// wsHandler's MARK_DEBT_PAID saves each claim here; a 5 s watcher keeps prompting the creditor on every open
// socket of theirs (again every 45 s while it is unanswered, and right away when they come online), and sends
// them one web push when the claim is new. RESPOND_MARK_PAID resolves it. The debtor is told the answer
// (confirmed / denied) live, or the next time they come online, plus a push for a denial.
// Claims older than 30 days expire. Exports { save, load, resolve, notify, startPaymentClaims }
const db = require('./db');
const sql = typeof db.prepare === 'function' ? db : db.db;

sql.exec(`
  CREATE TABLE IF NOT EXISTS payment_claims (
    id TEXT PRIMARY KEY, scope TEXT, code TEXT, debtor_id TEXT, debtor_name TEXT,
    creditor_id TEXT NOT NULL, creditor_name TEXT, amount REAL NOT NULL,
    created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', resolved_at INTEGER, pushed INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS idx_claims_creditor ON payment_claims(creditor_id, status);
  CREATE TABLE IF NOT EXISTS payment_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, delivered INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS idx_notices_user ON payment_notices(user_id, delivered);
`);

const REPROMPT_MS = 45 * 1000;
const EXPIRE_MS = 30 * 24 * 3600 * 1000;
let push = null;
try { push = require('./push'); } catch (e) {}

function socketsOf(userId) {
    const out = [];
    const wss = global.blitz31Wss;
    if (!wss || !wss.clients || !userId) return out;
    wss.clients.forEach(ws => { if (ws && ws.readyState === 1 && String(ws.userId || '') === String(userId)) out.push(ws); });
    return out;
}
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; } }

function save(req) {
    if (!req || !req.requestId || !req.creditorId) return false;
    try {
        sql.prepare(`INSERT OR IGNORE INTO payment_claims (id, scope, code, debtor_id, debtor_name, creditor_id, creditor_name, amount, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?)`).run(req.requestId, req.scope, req.code || null, req.debtorId || null, req.debtorUsername || null,
            String(req.creditorId), req.creditorUsername || null, Number(req.amount), req.createdAt || Date.now());
        return true;
    } catch (e) { console.error('[Claims] save failed:', e.message); return false; }
}
function rowToReq(r) {
    return { requestId: r.id, scope: r.scope, code: r.code, debtorId: r.debtor_id, debtorUsername: r.debtor_name,
        creditorId: r.creditor_id, creditorUsername: r.creditor_name, amount: Number(r.amount), createdAt: r.created_at };
}
function load(id) {
    try { const r = sql.prepare("SELECT * FROM payment_claims WHERE id = ? AND status = 'pending'").get(String(id || '')); return r ? rowToReq(r) : null; } catch (e) { return null; }
}
// returns true only for the first answer (stops double-applying a confirm)
function resolve(id, confirmed) {
    try {
        return sql.prepare("UPDATE payment_claims SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
            .run(confirmed ? 'confirmed' : 'denied', Date.now(), String(id)).changes > 0;
    } catch (e) { return true; }
}
function isResolved(id) {
    try { const r = sql.prepare('SELECT status FROM payment_claims WHERE id = ?').get(String(id)); return !!(r && r.status !== 'pending'); } catch (e) { return false; }
}
// tell a user something now, or store it until they are online
function notify(userId, payload, pushText) {
    if (!userId) return;
    const socks = socketsOf(userId);
    if (socks.length) socks.forEach(ws => send(ws, payload));
    else {
        try { sql.prepare('INSERT INTO payment_notices (user_id, payload, created_at) VALUES (?,?,?)').run(String(userId), JSON.stringify(payload), Date.now()); } catch (e) {}
        if (pushText && push && typeof push.sendToUser === 'function') {
            try { push.sendToUser(userId, { title: 'Blitz 31', body: pushText, url: '/', tag: 'pay-' + (payload.requestId || '') }, { kind: 'payment-result' }); } catch (e) {}
        }
    }
}

function promptPayload(r) {
    return { type: 'PAYMENT_CONFIRM_PROMPT', requestId: r.id, scope: r.scope, code: r.code, debtorId: r.debtor_id,
        debtorUsername: r.debtor_name, creditorId: r.creditor_id, creditorUsername: r.creditor_name, amount: Number(r.amount) };
}
function tick() {
    const now = Date.now();
    try { sql.prepare("UPDATE payment_claims SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND created_at < ?").run(now, now - EXPIRE_MS); } catch (e) {}
    let rows = [];
    try { rows = sql.prepare("SELECT * FROM payment_claims WHERE status = 'pending' ORDER BY created_at").all(); } catch (e) { return; }
    rows.forEach(r => {
        const socks = socketsOf(r.creditor_id);
        socks.forEach(ws => {
            const seen = ws.__claimPrompted || (ws.__claimPrompted = {});
            if (seen[r.id] && now - seen[r.id] < REPROMPT_MS) return;
            if (send(ws, promptPayload(r))) seen[r.id] = now;
        });
        if (!socks.length && !r.pushed && push && typeof push.sendToUser === 'function') {
            try {
                push.sendToUser(r.creditor_id, { title: 'Blitz 31 💸', body: `${r.debtor_name || 'A player'} marked $${Number(r.amount).toFixed(2)} as paid to you. Open the app to confirm or deny.`, url: '/', tag: 'claim-' + r.id }, { kind: 'payment-claim' });
                sql.prepare('UPDATE payment_claims SET pushed = 1 WHERE id = ?').run(r.id);
            } catch (e) {}
        }
    });
    // deliver stored results to people who are back online
    let notes = [];
    try { notes = sql.prepare('SELECT * FROM payment_notices WHERE delivered = 0 ORDER BY id LIMIT 200').all(); } catch (e) { return; }
    notes.forEach(n => {
        const socks = socketsOf(n.user_id);
        if (!socks.length) return;
        let p = null; try { p = JSON.parse(n.payload); } catch (e) {}
        if (p) socks.forEach(ws => send(ws, p));
        try { sql.prepare('UPDATE payment_notices SET delivered = 1 WHERE id = ?').run(n.id); } catch (e) {}
    });
    try { sql.prepare('DELETE FROM payment_notices WHERE delivered = 1 AND created_at < ?').run(now - EXPIRE_MS); } catch (e) {}
}

function startPaymentClaims() {
    const t = setInterval(tick, 5000);
    if (t.unref) t.unref();
    console.log('[Claims] running');
}

module.exports = { save, load, resolve, isResolved, notify, startPaymentClaims, tick };
