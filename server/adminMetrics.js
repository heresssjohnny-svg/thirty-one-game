// server/adminMetrics.js - numbers for the admin "📈 Growth" dashboard.
// active_days(day, user_id): one row per real account per New York calendar day they opened the app or played
// (touchActive is called from /api/premium/me and when a round is recorded). compute() reads everything else
// from existing tables (users, round_log/round_user, match_log, push_subscriptions, live lobbies).
const db = require('./db');
const sql = typeof db.prepare === 'function' ? db : db.db;

sql.exec(`CREATE TABLE IF NOT EXISTS active_days (day TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (day, user_id));
          CREATE INDEX IF NOT EXISTS idx_active_user ON active_days(user_id);`);

const TZ = 'America/New_York';
function dayOf(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); }   // YYYY-MM-DD
function isGuest(id) { return !id || String(id).startsWith('gst_') || String(id).startsWith('usr_guest_'); }

const seen = new Map();   // uid -> day already written (avoid a write per request)
function touchActive(uid) {
    if (isGuest(uid)) return;
    const d = dayOf(Date.now());
    if (seen.get(uid) === d) return;
    seen.set(uid, d);
    if (seen.size > 20000) seen.clear();
    try { sql.prepare('INSERT OR IGNORE INTO active_days (day, user_id) VALUES (?, ?)').run(d, String(uid)); } catch (e) {}
}

function lastDays(n) {
    const out = [], now = Date.now();
    for (let i = n - 1; i >= 0; i--) out.push(dayOf(now - i * 86400000));
    return [...new Set(out)];
}
// SQLite created_at is UTC 'YYYY-MM-DD HH:MM:SS'
function utcToMs(s) { const t = Date.parse(String(s || '').replace(' ', 'T') + 'Z'); return isNaN(t) ? null : t; }

function compute(lobbyManager) {
    const now = Date.now(), days = lastDays(30), dset = new Set(days);
    const series = () => Object.fromEntries(days.map(d => [d, 0]));
    const out = { tz: TZ, days };

    // ---- accounts / sign-ups
    const users = sql.prepare("SELECT id, created_at, signup_at_ms FROM users WHERE COALESCE(provider,'local') != 'guest'").all();
    out.totalUsers = users.length;
    const signups = series();
    let su1 = 0, su7 = 0, su30 = 0;
    users.forEach(u => {
        const ms = Number(u.signup_at_ms) || utcToMs(u.created_at); if (!ms) return;
        const d = dayOf(ms); if (dset.has(d)) signups[d]++;
        const age = now - ms; if (age < 86400000) su1++; if (age < 7 * 86400000) su7++; if (age < 30 * 86400000) su30++;
    });
    out.signups = { today: signups[days[days.length - 1]] || 0, last24h: su1, last7d: su7, last30d: su30, byDay: days.map(d => signups[d]) };

    // ---- active players (opened the app or played)
    const act = series();
    const actRows = sql.prepare('SELECT day, COUNT(*) n FROM active_days WHERE day >= ? GROUP BY day').all(days[0]);
    actRows.forEach(r => { if (dset.has(r.day)) act[r.day] = r.n; });
    const d7 = days.slice(-7);
    out.active = {
        today: act[days[days.length - 1]] || 0,
        last7d: sql.prepare(`SELECT COUNT(DISTINCT user_id) n FROM active_days WHERE day >= ?`).get(d7[0]).n,
        last30d: sql.prepare(`SELECT COUNT(DISTINCT user_id) n FROM active_days WHERE day >= ?`).get(days[0]).n,
        returning7d: sql.prepare(`SELECT COUNT(*) n FROM (SELECT user_id FROM active_days WHERE day >= ? GROUP BY user_id HAVING COUNT(*) >= 2)`).get(d7[0]).n,
        byDay: days.map(d => act[d]),
        since: (sql.prepare('SELECT MIN(day) d FROM active_days').get() || {}).d || null
    };

    // ---- games
    const rounds = series(), matches = series(), players = {};
    const since = now - 31 * 86400000;
    try {
        sql.prepare('SELECT at FROM round_log WHERE at >= ?').all(since).forEach(r => { const d = dayOf(r.at); if (dset.has(d)) rounds[d]++; });
        sql.prepare('SELECT at FROM match_log WHERE at >= ?').all(since).forEach(r => { const d = dayOf(r.at); if (dset.has(d)) matches[d]++; });
        sql.prepare('SELECT at, user_id FROM round_user WHERE at >= ?').all(since).forEach(r => { const d = dayOf(r.at); if (dset.has(d)) (players[d] = players[d] || new Set()).add(r.user_id); });
    } catch (e) {}
    out.games = {
        roundsByDay: days.map(d => rounds[d]), matchesByDay: days.map(d => matches[d]),
        playersByDay: days.map(d => (players[d] ? players[d].size : 0)),
        rounds7d: d7.reduce((a, d) => a + rounds[d], 0), matches7d: d7.reduce((a, d) => a + matches[d], 0)
    };
    try { const s = sql.prepare('SELECT COALESCE(SUM(games),0) g FROM user_stats').get(); out.games.allTimePlayerGames = s.g; } catch (e) {}

    // ---- invites
    try {
        const r = sql.prepare('SELECT COUNT(*) j, SUM(CASE WHEN ref_rewarded = 1 THEN 1 ELSE 0 END) rw FROM users WHERE referred_by IS NOT NULL').get();
        const top = sql.prepare(`SELECT i.username name, COUNT(*) n, SUM(CASE WHEN u.ref_rewarded = 1 THEN 1 ELSE 0 END) played
                                 FROM users u JOIN users i ON i.id = u.referred_by GROUP BY u.referred_by ORDER BY n DESC LIMIT 5`).all();
        out.invites = { joined: r.j || 0, played: r.rw || 0, top };
    } catch (e) { out.invites = { joined: 0, played: 0, top: [] }; }

    // ---- premium
    try {
        const p = sql.prepare(`SELECT
            SUM(CASE WHEN is_admin = 1 THEN 1 ELSE 0 END) admins,
            SUM(CASE WHEN is_premium = 1 THEN 1 ELSE 0 END) granted,
            SUM(CASE WHEN premium_until > ? THEN 1 ELSE 0 END) earned,
            SUM(CASE WHEN trial_until > ? THEN 1 ELSE 0 END) trialActive,
            SUM(CASE WHEN trial_until > 0 AND trial_until <= ? THEN 1 ELSE 0 END) trialEnded
            FROM users WHERE COALESCE(provider,'local') != 'guest'`).get(now, now, now);
        out.premium = { admins: p.admins || 0, granted: p.granted || 0, earned: p.earned || 0, trialActive: p.trialActive || 0, trialEnded: p.trialEnded || 0 };
    } catch (e) { out.premium = {}; }

    // ---- notifications
    try { out.push = { users: sql.prepare('SELECT COUNT(DISTINCT user_id) n FROM push_subscriptions').get().n }; } catch (e) { out.push = { users: 0 }; }

    // ---- right now
    const live = { tables: 0, playing: 0, seated: 0, online: 0 };
    try {
        Object.values((lobbyManager && lobbyManager.lobbies) || {}).forEach(l => {
            const humans = (l.players || []).filter(p => p && !p.isBot);
            if (!humans.length) return;
            live.tables++; live.seated += humans.length;
            if (['playing', 'finalTurn', 'roundOver', 'dealerDraw', 'tieBreaker'].includes(l.gameState)) live.playing++;
        });
        const ids = new Set();
        const wss = global.blitz31Wss;
        if (wss && wss.clients) wss.clients.forEach(ws => { if (ws && ws.readyState === 1 && ws.userId) ids.add(String(ws.userId)); });
        live.online = ids.size;
    } catch (e) {}
    out.live = live;
    return out;
}

module.exports = { touchActive, compute, dayOf };
