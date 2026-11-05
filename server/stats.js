// server/stats.js - player stats, daily streaks and the leaderboard.
//
// Nothing in lobbyManager.js is modified. A small watcher looks at the shared `lobbies` object once a
// second; when a table reaches 'tournamentEnd' with a winner it records the result once (the lobby gets
// a __statsRecorded flag until it leaves that state).
//
//   user_stats     one row per real account: games/wins (all tables), human_games/human_wins (tables with
//                  at least two humans - these feed the leaderboard so bot tables cannot be farmed),
//                  win streak, daily play streak (UTC days)
//   match_results  one row per player per finished match, used for the weekly leaderboard
//
// Guests and bots never get rows.
//
//   GET /api/stats/me                Bearer token -> your numbers (guests get { guest: true })
//   GET /api/leaderboard?period=week|all   top 10 + your rank when a token is sent
//
// Exports: router, startStatsTracker({ lobbyManager }), recordMatch (for tests), dayOf.

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const { clientIp, isGuestUserId } = require('./guest');

const router = express.Router();
const sql = typeof db.prepare === 'function' ? db : db.db;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const KEEP_RESULTS_MS = 120 * DAY_MS;
const TOP_N = 10;

sql.exec(`
  CREATE TABLE IF NOT EXISTS user_stats (
    user_id TEXT PRIMARY KEY,
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    human_games INTEGER NOT NULL DEFAULT 0,
    human_wins INTEGER NOT NULL DEFAULT 0,
    win_streak INTEGER NOT NULL DEFAULT 0,
    best_win_streak INTEGER NOT NULL DEFAULT 0,
    day_streak INTEGER NOT NULL DEFAULT 0,
    best_day_streak INTEGER NOT NULL DEFAULT 0,
    last_play_day TEXT,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS match_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    won INTEGER NOT NULL,
    humans INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_match_results_at ON match_results(at);
`);

// -------------------------------------------------------------
// 1. RECORDING
// -------------------------------------------------------------
function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function prevDay(day) { return dayOf(Date.parse(day + 'T00:00:00Z') - DAY_MS); }

// players: [{ userId, won }] real accounts only; humans: how many non-bot players sat at the table
function recordMatch(players, humans, now) {
    now = now || Date.now();
    const today = dayOf(now);
    const countsForBoard = humans >= 2;
    const get = sql.prepare('SELECT * FROM user_stats WHERE user_id = ?');
    const put = sql.prepare(`
      INSERT INTO user_stats (user_id, games, wins, human_games, human_wins, win_streak, best_win_streak,
                              day_streak, best_day_streak, last_play_day, updated_at)
      VALUES (@user_id, @games, @wins, @human_games, @human_wins, @win_streak, @best_win_streak,
              @day_streak, @best_day_streak, @last_play_day, @updated_at)
      ON CONFLICT(user_id) DO UPDATE SET games=@games, wins=@wins, human_games=@human_games, human_wins=@human_wins,
        win_streak=@win_streak, best_win_streak=@best_win_streak, day_streak=@day_streak,
        best_day_streak=@best_day_streak, last_play_day=@last_play_day, updated_at=@updated_at`);
    const log = sql.prepare('INSERT INTO match_results (user_id, won, humans, at) VALUES (?, ?, ?, ?)');

    const run = (list) => {
        for (const p of list) {
            const row = get.get(p.userId) || {
                user_id: p.userId, games: 0, wins: 0, human_games: 0, human_wins: 0, win_streak: 0,
                best_win_streak: 0, day_streak: 0, best_day_streak: 0, last_play_day: null
            };
            row.games += 1;
            if (p.won) row.wins += 1;
            if (countsForBoard) { row.human_games += 1; if (p.won) row.human_wins += 1; }
            row.win_streak = p.won ? row.win_streak + 1 : 0;
            row.best_win_streak = Math.max(row.best_win_streak, row.win_streak);
            if (row.last_play_day !== today) {
                row.day_streak = row.last_play_day === prevDay(today) ? row.day_streak + 1 : 1;
                row.last_play_day = today;
            }
            row.best_day_streak = Math.max(row.best_day_streak, row.day_streak);
            row.updated_at = now;
            put.run(row);
            log.run(p.userId, p.won ? 1 : 0, humans, now);
        }
    };
    if (typeof sql.transaction === 'function') sql.transaction(run)(players); else run(players);
}

function purgeOldResults() {
    try { sql.prepare('DELETE FROM match_results WHERE at < ?').run(Date.now() - KEEP_RESULTS_MS); } catch (e) {}
}

// Look at a finished table and record it. Returns true when something was recorded.
function recordFinishedLobby(lobby, lobbyManager) {
    const winnerName = String(lobby.tournamentWinner || '').toLowerCase();
    if (!winnerName) return false;
    const seen = new Set();
    const list = [];
    let humans = 0;
    const everyone = (lobby.players || []).concat(lobby.forfeitedPlayers || []);
    for (const p of everyone) {
        if (!p || p.isBot) continue;
        const handle = String(p.username || '').toLowerCase();
        if (!handle || seen.has(handle)) continue;
        seen.add(handle);
        humans += 1;
        let uid = p.userId || null;
        if (!uid && lobbyManager && typeof lobbyManager.resolveUserId === 'function') {
            try { uid = lobbyManager.resolveUserId(lobby, p.accountUsername || p.username) || null; } catch (e) {}
        }
        if (!uid || isGuestUserId(uid)) continue;
        list.push({ userId: String(uid), won: handle === winnerName });
    }
    if (!list.length) return false;
    recordMatch(list, humans);
    return true;
}

function startStatsTracker({ lobbyManager }) {
    purgeOldResults();
    setInterval(purgeOldResults, DAY_MS).unref();
    const timer = setInterval(() => {
        const lobbies = lobbyManager.lobbies || {};
        for (const code of Object.keys(lobbies)) {
            const lobby = lobbies[code];
            if (!lobby) continue;
            if (lobby.gameState === 'tournamentEnd') {
                if (lobby.__statsRecorded) continue;
                lobby.__statsRecorded = true;
                try { recordFinishedLobby(lobby, lobbyManager); }
                catch (err) { console.error('[Stats] record failed:', err.message); }
            } else if (lobby.__statsRecorded) {
                lobby.__statsRecorded = false;
            }
        }
    }, 1000);
    timer.unref();
    console.log('[Stats] tracker running');
}

// -------------------------------------------------------------
// 2. READING
// -------------------------------------------------------------
function userIdFromReq(req) {
    const h = req.headers && req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return null;
    try {
        const d = jwt.verify(h.split(' ')[1], config.JWT_SECRET);
        return d && d.userId ? String(d.userId) : null;
    } catch (e) { return null; }
}

// Plain per-IP limiter (behind Caddy req.ip is always 127.0.0.1, so use the forwarded address)
const hits = new Map();
function limited(req) {
    const ip = clientIp(req), now = Date.now();
    let rec = hits.get(ip);
    if (!rec || now > rec.resetAt) { rec = { n: 0, resetAt: now + 60000 }; hits.set(ip, rec); }
    rec.n += 1;
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    return rec.n > 90;
}

router.get('/stats/me', (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many requests.' });
    const uid = userIdFromReq(req);
    if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
    if (isGuestUserId(uid)) return res.json({ guest: true });
    const r = sql.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(uid);
    const today = dayOf(Date.now());
    const alive = r && (r.last_play_day === today || r.last_play_day === prevDay(today));
    res.set('Cache-Control', 'no-store');
    res.json({
        guest: false,
        games: r ? r.games : 0,
        wins: r ? r.wins : 0,
        winRate: r && r.games ? Math.round((r.wins / r.games) * 100) : 0,
        humanGames: r ? r.human_games : 0,
        humanWins: r ? r.human_wins : 0,
        winStreak: r ? r.win_streak : 0,
        bestWinStreak: r ? r.best_win_streak : 0,
        dayStreak: alive ? r.day_streak : 0,
        bestDayStreak: r ? r.best_day_streak : 0,
        playedToday: !!r && r.last_play_day === today,
        streakAtRisk: !!r && r.last_play_day === prevDay(today) && r.day_streak > 0
    });
});

const boardCache = new Map(); // period -> { at, rows }
function boardRows(period) {
    const hit = boardCache.get(period);
    if (hit && Date.now() - hit.at < 30000) return hit.rows;
    let rows;
    if (period === 'week') {
        rows = sql.prepare(`
          SELECT m.user_id AS user_id, u.username AS username, SUM(m.won) AS wins, COUNT(*) AS games
          FROM match_results m JOIN users u ON u.id = m.user_id
          WHERE m.humans >= 2 AND m.at >= ?
          GROUP BY m.user_id HAVING SUM(m.won) > 0
          ORDER BY wins DESC, games ASC, MIN(m.at) ASC LIMIT 200`).all(Date.now() - WEEK_MS);
    } else {
        rows = sql.prepare(`
          SELECT s.user_id AS user_id, u.username AS username, s.human_wins AS wins, s.human_games AS games
          FROM user_stats s JOIN users u ON u.id = s.user_id
          WHERE s.human_wins > 0
          ORDER BY wins DESC, games ASC, s.updated_at ASC LIMIT 200`).all();
    }
    boardCache.set(period, { at: Date.now(), rows });
    return rows;
}

router.get('/leaderboard', (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many requests.' });
    const period = req.query && req.query.period === 'all' ? 'all' : 'week';
    const rows = boardRows(period);
    const uid = userIdFromReq(req);
    let me = null;
    if (uid) {
        const idx = rows.findIndex(r => r.user_id === uid);
        if (idx >= 0) me = { rank: idx + 1, wins: rows[idx].wins, games: rows[idx].games };
    }
    res.set('Cache-Control', 'no-store');
    res.json({
        period,
        top: rows.slice(0, TOP_N).map((r, i) => ({ rank: i + 1, username: r.username, wins: r.wins, games: r.games, me: r.user_id === uid })),
        me
    });
});

module.exports = { router, startStatsTracker, recordMatch, recordFinishedLobby, dayOf };
