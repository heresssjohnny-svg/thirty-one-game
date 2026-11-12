// server/roundLog.js - records every finished round (and match) for the Premium stats deep-dive and
// hand history. A 500 ms watcher (no edits to lobbyManager) notes each round's start (lives per player),
// then, when the table reaches roundOver / tournamentEnd, saves the final hands, scores, who lost a life,
// who knocked and who hit 31. Real accounts only; guests and bots are listed by name but never get stats.
//
//   GET /api/stats/deep   -> { rounds, avgScore, best, hit31, knocks, knockSafe, livesLost, survived, matches, h2h:[...] }
//   GET /api/history      -> { rounds:[{at, table, players:[{name, cards, score, lostLife, out, hit31, knocked, me}]}] }  (last 15)
// Both need Premium (or admin). Exports { router, startRoundLog, recordRound }
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const { statusFor } = require('./premium');
const { calculateScore } = require('./game/deck');

const sql = typeof db.prepare === 'function' ? db : db.db;
const DAY = 24 * 3600 * 1000;
const KEEP_MS = 180 * DAY;

sql.exec(`
  CREATE TABLE IF NOT EXISTS round_log (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, table_name TEXT, at INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS round_user (round_id INTEGER NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_round_user ON round_user(user_id, at);
  CREATE TABLE IF NOT EXISTS match_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, winner_uid TEXT, uids TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS match_user (match_id INTEGER NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_match_user ON match_user(user_id, at);
`);

function isGuest(uid) { return !uid || String(uid).startsWith('gst_') || String(uid).startsWith('usr_guest_'); }
function uidOf(lobby, p, lm) {
    let uid = p.userId || null;
    if (!uid && lm && typeof lm.resolveUserId === 'function') { try { uid = lm.resolveUserId(lobby, p.accountUsername || p.username) || null; } catch (e) {} }
    return uid && !isGuest(uid) ? String(uid) : null;
}
function cardsOf(p) { return Array.isArray(p.cards) ? p.cards.filter(Boolean).map(c => ({ val: String(c.val || ''), suit: String(c.suit || '') })) : []; }
function pts(v) { return v === 'A' ? 11 : (['J', 'Q', 'K'].includes(v) ? 10 : (parseInt(v, 10) || 0)); }
function scoreOf(cards) {
    try { return cards.length ? Number(calculateScore(cards.slice(0, 3).map(c => ({ suit: c.suit, val: c.val, points: pts(c.val) })))) || 0 : 0; } catch (e) { return 0; }
}

function recordRound(lobby, start, lm) {
    const now = Date.now();
    const everyone = (lobby.players || []).concat(lobby.forfeitedPlayers || []);
    const players = [];
    for (const s of start.players) {
        const cur = everyone.find(p => p && p.username === s.username);
        const cards = (cur && cardsOf(cur).length ? cardsOf(cur) : (start.lastCards[s.username] || []));
        const lives = cur ? Number(cur.lives) : 0;
        players.push({
            name: s.username, uid: s.uid, bot: s.bot, cards, score: scoreOf(cards),
            lostLife: lives < s.lives, out: lives <= 0 && s.lives > 0,
            hit31: !!lobby.hit31Player && lobby.hit31Player === s.username,
            knocked: !!start.knockedBy && start.knockedBy === s.username
        });
    }
    if (!players.some(p => p.uid)) return null;
    const info = sql.prepare('INSERT INTO round_log (code, table_name, at, data) VALUES (?,?,?,?)')
        .run(lobby.code || '', String(lobby.name || '').slice(0, 40), now, JSON.stringify({ players }));
    const ins = sql.prepare('INSERT INTO round_user (round_id, user_id, at) VALUES (?,?,?)');
    let touch = null; try { touch = require('./adminMetrics').touchActive; } catch (e) {}
    players.forEach(p => { if (p.uid) { ins.run(info.lastInsertRowid, p.uid, now); if (touch) touch(p.uid); } });
    return info.lastInsertRowid;
}
function recordMatch(lobby, lm) {
    const now = Date.now(), winner = String(lobby.tournamentWinner || '').toLowerCase();
    const everyone = (lobby.players || []).concat(lobby.forfeitedPlayers || []);
    const uids = [], seen = new Set(); let wuid = null;
    everyone.forEach(p => {
        if (!p || p.isBot) return;
        const u = uidOf(lobby, p, lm); if (!u || seen.has(u)) return;
        seen.add(u); uids.push(u);
        if (String(p.username || '').toLowerCase() === winner) wuid = u;
    });
    if (uids.length < 2) return;
    const info = sql.prepare('INSERT INTO match_log (at, winner_uid, uids) VALUES (?,?,?)').run(now, wuid, JSON.stringify(uids));
    const ins = sql.prepare('INSERT INTO match_user (match_id, user_id, at) VALUES (?,?,?)');
    uids.forEach(u => ins.run(info.lastInsertRowid, u, now));
}

function purge() {
    const cut = Date.now() - KEEP_MS;
    try {
        sql.prepare('DELETE FROM round_user WHERE at < ?').run(cut);
        sql.prepare('DELETE FROM round_log WHERE at < ?').run(cut);
        sql.prepare('DELETE FROM match_user WHERE at < ?').run(cut);
        sql.prepare('DELETE FROM match_log WHERE at < ?').run(cut);
    } catch (e) {}
}

function tick(lobby, lm) {
    const st = lobby.gameState;
    const w = lobby.__rl || (lobby.__rl = { phase: null, start: null });
    const playing = st === 'playing' || st === 'finalTurn';
    if (playing) {
        if (!w.start) {
            w.start = {
                players: (lobby.players || []).filter(p => p && !p.eliminated).map(p => ({ username: p.username, uid: p.isBot ? null : uidOf(lobby, p, lm), bot: !!p.isBot, lives: Number(p.lives) || 0 })),
                lastCards: {}, knockedBy: null
            };
        }
        (lobby.players || []).forEach(p => { const c = p && cardsOf(p); if (c && c.length) w.start.lastCards[p.username] = c; });
        if (lobby.knockedBy) w.start.knockedBy = lobby.knockedBy;
    } else if ((st === 'roundOver' || st === 'tournamentEnd') && w.start) {
        try { recordRound(lobby, w.start, lm); } catch (e) { console.error('[RoundLog] round failed:', e.message); }
        w.start = null;
    } else if (!playing && st !== 'roundOver' && st !== 'tournamentEnd') {
        w.start = null;   // left mid-round (reset to lobby etc.)
    }
    if (st === 'tournamentEnd') {
        if (!w.matchDone) { w.matchDone = true; try { recordMatch(lobby, lm); } catch (e) { console.error('[RoundLog] match failed:', e.message); } }
    } else w.matchDone = false;
}

function startRoundLog({ lobbyManager }) {
    purge();
    setInterval(purge, DAY).unref();
    const t = setInterval(() => {
        const lobbies = lobbyManager.lobbies || {};
        for (const code of Object.keys(lobbies)) { const l = lobbies[code]; if (l) { try { tick(l, lobbyManager); } catch (e) {} } }
    }, 500);
    t.unref();
    console.log('[RoundLog] running');
}

// ---------------- reading ----------------
function uidFromReq(req) {
    const h = req.headers && req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return null;
    try { const d = jwt.verify(h.split(' ')[1], config.JWT_SECRET); return d && d.userId ? String(d.userId) : null; } catch (e) { return null; }
}
const nameCache = new Map();
function nameOfUid(uid) {
    if (nameCache.has(uid)) return nameCache.get(uid);
    let n = null; try { const r = sql.prepare('SELECT username FROM users WHERE id = ?').get(uid); n = r && r.username; } catch (e) {}
    if (nameCache.size > 2000) nameCache.clear();
    nameCache.set(uid, n || 'Player'); return n || 'Player';
}
function gate(req, res) {
    const uid = uidFromReq(req);
    if (!uid) { res.status(401).json({ error: 'Sign in first.' }); return null; }
    if (!statusFor(uid).premium) { res.status(403).json({ error: 'Premium', premium: false }); return null; }
    res.set('Cache-Control', 'no-store');
    return uid;
}

function deepStats(uid) {
    const rows = sql.prepare('SELECT l.data FROM round_user u JOIN round_log l ON l.id = u.round_id WHERE u.user_id = ? ORDER BY u.at DESC LIMIT 1000').all(uid);
    let rounds = 0, total = 0, best = 0, hit31 = 0, knocks = 0, knockSafe = 0, livesLost = 0, outs = 0;
    const h2h = {};
    rows.forEach(r => {
        let d; try { d = JSON.parse(r.data); } catch (e) { return; }
        const me = (d.players || []).find(p => p.uid === uid); if (!me) return;
        rounds++; total += me.score; best = Math.max(best, me.score);
        if (me.hit31) hit31++;
        if (me.knocked) { knocks++; if (!me.lostLife) knockSafe++; }
        if (me.lostLife) livesLost++;
        if (me.out) outs++;
        (d.players || []).forEach(o => {
            if (!o.uid || o.uid === uid) return;
            const h = h2h[o.uid] || (h2h[o.uid] = { uid: o.uid, rounds: 0, myLost: 0, theirLost: 0, matches: 0, myWins: 0, theirWins: 0 });
            h.rounds++; if (me.lostLife) h.myLost++; if (o.lostLife) h.theirLost++;
        });
    });
    const ms = sql.prepare('SELECT m.winner_uid, m.uids FROM match_user u JOIN match_log m ON m.id = u.match_id WHERE u.user_id = ? ORDER BY u.at DESC LIMIT 1000').all(uid);
    let matches = 0, wins = 0;
    ms.forEach(m => {
        let list; try { list = JSON.parse(m.uids); } catch (e) { return; }
        matches++; if (m.winner_uid === uid) wins++;
        list.forEach(o => {
            if (o === uid) return;
            const h = h2h[o] || (h2h[o] = { uid: o, rounds: 0, myLost: 0, theirLost: 0, matches: 0, myWins: 0, theirWins: 0 });
            h.matches++; if (m.winner_uid === uid) h.myWins++; else if (m.winner_uid === o) h.theirWins++;
        });
    });
    const list = Object.values(h2h).sort((a, b) => (b.matches + b.rounds) - (a.matches + a.rounds)).slice(0, 12)
        .map(h => ({ name: nameOfUid(h.uid), rounds: h.rounds, myLost: h.myLost, theirLost: h.theirLost, matches: h.matches, myWins: h.myWins, theirWins: h.theirWins }));
    return {
        rounds, avgScore: rounds ? Math.round((total / rounds) * 10) / 10 : 0, best, hit31, knocks,
        knockSafe, knockRate: knocks ? Math.round((knockSafe / knocks) * 100) : 0, livesLost, outs,
        survived: rounds ? Math.round(((rounds - livesLost) / rounds) * 100) : 0,
        matches, wins, winRate: matches ? Math.round((wins / matches) * 100) : 0, h2h: list
    };
}

// head-to-head between two specific players (rounds they shared + matches they both played)
function h2hBetween(a, b) {
    const out = { rounds: 0, aLost: 0, bLost: 0, matches: 0, aWins: 0, bWins: 0 };
    const rows = sql.prepare('SELECT l.data FROM round_user u JOIN round_log l ON l.id = u.round_id WHERE u.user_id = ? ORDER BY u.at DESC LIMIT 2000').all(a);
    rows.forEach(r => {
        let d; try { d = JSON.parse(r.data); } catch (e) { return; }
        const pa = (d.players || []).find(p => p.uid === a), pb = (d.players || []).find(p => p.uid === b);
        if (!pa || !pb) return;
        out.rounds++; if (pa.lostLife) out.aLost++; if (pb.lostLife) out.bLost++;
    });
    sql.prepare('SELECT m.winner_uid, m.uids FROM match_user u JOIN match_log m ON m.id = u.match_id WHERE u.user_id = ? ORDER BY u.at DESC LIMIT 2000').all(a).forEach(m => {
        let list; try { list = JSON.parse(m.uids); } catch (e) { return; }
        if (!list.includes(b)) return;
        out.matches++; if (m.winner_uid === a) out.aWins++; else if (m.winner_uid === b) out.bWins++;
    });
    return out;
}

const router = express.Router();
const hits = new Map();
function limited(key) {
    const now = Date.now(); let r = hits.get(key);
    if (!r || now > r.reset) { r = { n: 0, reset: now + 60000 }; hits.set(key, r); }
    r.n++; if (hits.size > 5000) hits.clear(); return r.n > 40;
}
router.get('/stats/deep', (req, res) => {
    const uid = gate(req, res); if (!uid) return;
    if (limited(uid)) return res.status(429).json({ error: 'Too many requests.' });
    res.json(deepStats(uid));
});
router.get('/history', (req, res) => {
    const uid = gate(req, res); if (!uid) return;
    if (limited(uid)) return res.status(429).json({ error: 'Too many requests.' });
    const rows = sql.prepare('SELECT l.at, l.table_name, l.data FROM round_user u JOIN round_log l ON l.id = u.round_id WHERE u.user_id = ? ORDER BY u.at DESC LIMIT 15').all(uid);
    res.json({
        rounds: rows.map(r => {
            let d = {}; try { d = JSON.parse(r.data); } catch (e) {}
            return { at: r.at, table: r.table_name, players: (d.players || []).map(p => ({ name: p.name, bot: !!p.bot, cards: p.cards, score: p.score, lostLife: p.lostLife, out: p.out, hit31: p.hit31, knocked: p.knocked, me: p.uid === uid })) };
        })
    });
});

module.exports = { router, startRoundLog, recordRound, deepStats, h2hBetween, tick };
