// server/emotes.js - Premium "throw an emote at a player": THROW_EMOTE {to, emote}
// -> every socket at the table gets EMOTE_THROWN {code, from, to, emote} and animates it.
// Premium / admin only, 1 throw per 1.5 s per socket, only at seated players of your own table.
const { statusFor } = require('./premium');
const { hasBlocked } = require('./safety');

const EMOTES = ['🍅', '🥚', '💩', '🌹', '💋', '🔥', '❄️', '💣', '🎯', '🥧', '👟', '💎'];
const COOLDOWN_MS = 1500;

function lobbyOf(lobbies, ws) {
    for (const code of Object.keys(lobbies || {})) {
        const l = lobbies[code];
        if (!l) continue;
        const p = (l.players || []).find(x => x && x.id === ws);
        if (p) return { lobby: l, name: p.username, seated: true };
        const s = (l.spectators || []).find(x => x && x.idSocket === ws);
        if (s) return { lobby: l, name: s.username, seated: false };
    }
    return null;
}

function send(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }

function handleEmoteMessage(ws, msg, lobbyManager) {
    if (!msg || msg.type !== 'THROW_EMOTE') return false;
    if (!statusFor(ws && ws.userId).premium) { send(ws, { type: 'ERROR', message: '🔒 Emotes are Premium.' }); return true; }
    const now = Date.now();
    if (ws.__emoteAt && now - ws.__emoteAt < COOLDOWN_MS) return true;
    const emote = String(msg.emote || '');
    if (!EMOTES.includes(emote)) return true;
    const found = lobbyOf(lobbyManager && lobbyManager.lobbies, ws);
    if (!found || !found.seated) return true;
    const to = String(msg.to || '').trim().toLowerCase();
    const target = (found.lobby.players || []).find(p => String(p.username || '').toLowerCase() === to);
    if (!target || target.username === found.name) return true;
    ws.__emoteAt = now;
    // a player who blocked the thrower never gets hit (nobody sees it); viewers who blocked the thrower don't see it either
    if (target.id && hasBlocked(target.id.userId, found.name)) return true;
    if (target.id && ws.userId && hasBlocked(ws.userId, target.username)) return true;
    const skip = (sock) => sock && sock.userId && hasBlocked(sock.userId, found.name);
    const out = { type: 'EMOTE_THROWN', code: found.lobby.code, from: found.name, to: target.username, emote };
    (found.lobby.players || []).forEach(p => { if (!p.isBot && !skip(p.id)) send(p.id, out); });
    (found.lobby.spectators || []).forEach(s => { if (!skip(s.idSocket)) send(s.idSocket, out); });
    return true;
}

module.exports = { handleEmoteMessage, EMOTES };
