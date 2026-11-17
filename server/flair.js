// server/flair.js - Premium "profile flair" the whole table sees: avatar, seat frame, name colour, title,
// entrance effect, knock animation and 31 animation.
//   SET_FLAIR {avatar, frame, color, title, entrance, knockFx, hitFx}
// Validated against the lists below (Premium/admin only; anything else falls back to the default), kept on the
// socket (ws.__flair) like celebration picks, and sent in the lobby snapshot as players[].flair (null = none).
// The client (public/js/premiumFlair.js) keeps the picks in localStorage and re-sends them after reconnects.
// Titles are a fixed list (ids only) so there is no free text to moderate.
const { statusFor } = require('./premium');

const AVATARS = ['😎', '🤠', '🦈', '🦁', '🐺', '🦊', '🐼', '🐸', '🦉', '🦅', '🐉', '👑', '💀', '👽', '🤖', '🎩', '🧙', '🥷', '🤡', '👻', '🔥', '💎', '🃏', '🎲'];
const FRAMES = ['gold', 'neon', 'fire', 'ice', 'rainbow'];
const COLORS = ['gold', 'red', 'blue', 'green', 'pink', 'purple', 'rainbow'];
const TITLES = ['shark', 'king', 'queen', 'highroller', 'bluff', 'lucky', 'knock', 'ice', 'dealer', 'legend', 'rookie', 'boss', 'closer'];
const ENTRANCES = ['spotlight', 'thunder', 'royal', 'money'];
const KNOCKFX = ['fist', 'lightning', 'shockwave'];
const HITFX = ['fire', 'gold', 'storm'];

function clean(msg) {
    const pick = (v, list, none) => list.includes(String(v)) ? String(v) : none;
    const f = {
        avatar: pick(msg.avatar, AVATARS, ''),
        frame: pick(msg.frame, FRAMES, 'none'),
        color: pick(msg.color, COLORS, 'default'),
        title: pick(msg.title, TITLES, 'none'),
        entrance: pick(msg.entrance, ENTRANCES, 'none'),
        knockFx: pick(msg.knockFx, KNOCKFX, 'default'),
        hitFx: pick(msg.hitFx, HITFX, 'default')
    };
    const plain = !f.avatar && f.frame === 'none' && f.color === 'default' && f.title === 'none' &&
        f.entrance === 'none' && f.knockFx === 'default' && f.hitFx === 'default';
    return plain ? null : f;
}

function lobbyOf(lobbies, ws) {
    for (const code of Object.keys(lobbies || {})) {
        const l = lobbies[code];
        if (l && (l.players || []).some(p => p && p.id === ws)) return l;
    }
    return null;
}

function handleFlairMessage(ws, msg, lobbyManager) {
    if (!msg || msg.type !== 'SET_FLAIR') return false;
    if (!ws) return true;
    const next = statusFor(ws.userId).premium ? clean(msg) : null;
    const changed = JSON.stringify(next) !== JSON.stringify(ws.__flair || null);
    ws.__flair = next;
    if (changed) {
        // show the table right away, but at most about once a second (a late change still goes out)
        const push = () => {
            ws.__flairAt = Date.now(); ws.__flairTimer = null;
            try { const l = lobbyOf(lobbyManager && lobbyManager.lobbies, ws); if (l) lobbyManager.broadcastLobbyUpdate(l.code); } catch (e) {}
        };
        const wait = 800 - (Date.now() - (ws.__flairAt || 0));
        if (wait <= 0) push();
        else if (!ws.__flairTimer) ws.__flairTimer = setTimeout(push, wait);
    }
    return true;
}

module.exports = { handleFlairMessage, AVATARS, FRAMES, COLORS, TITLES, ENTRANCES, KNOCKFX, HITFX };
