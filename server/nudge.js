// server/nudge.js - "👋 Nudge" a player at your table, and know whether a player's app is on screen.
//   NUDGE {to}          -> the target's socket gets NUDGED {code, from, yourTurn}; the sender gets NUDGE_SENT {to}.
//                          If the target's app is in the background / closed (see APP_STATE) and they turned on
//                          notifications, they also get a push notification.
//   APP_STATE {hidden}  -> remembered on the socket (ws.__appHidden) so we only push when they can't see the game.
// Rules: anyone at the table (player or spectator) can nudge a seated human player, not themselves; the same player
// once per 30 s; 6 nudges a minute per sender. Blocks: you can't nudge someone you blocked, and a player who blocked
// you never gets your nudges (you still see "Nudge sent", like other blocks).
const { hasBlocked } = require('./safety');

const SAME_TARGET_MS = 30000;
const PER_MINUTE = 6;

function send(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }

function findSeat(lobbies, ws) {
    for (const code of Object.keys(lobbies || {})) {
        const l = lobbies[code];
        if (!l) continue;
        const p = (l.players || []).find(x => x && x.id === ws);
        if (p) return { lobby: l, name: p.username };
        const s = (l.spectators || []).find(x => x && x.idSocket === ws);
        if (s) return { lobby: l, name: s.username };
    }
    return null;
}

function pushNudge(userId, from, code, yourTurn) {
    try {
        const push = require('./push');
        if (!push || typeof push.sendToUser !== 'function') return;
        push.sendToUser(userId, {
            title: 'Blitz 31 👋',
            body: yourTurn ? `${from} nudged you. It's your turn!` : `${from} nudged you at table ${code}.`,
            url: '/?join=' + encodeURIComponent(code),
            tag: 'nudge'
        }, { kind: 'nudge', ttl: 300 });
    } catch (e) {}
}

function handleNudgeMessage(ws, msg, lobbyManager) {
    if (!msg) return false;
    if (msg.type === 'APP_STATE') { ws.__appHidden = !!msg.hidden; ws.__appStateAt = Date.now(); return true; }
    if (msg.type !== 'NUDGE') return false;

    const found = findSeat(lobbyManager && lobbyManager.lobbies, ws);
    if (!found) return true;
    const want = String(msg.to || '').trim().toLowerCase();
    const target = (found.lobby.players || []).find(p => p && String(p.username || '').toLowerCase() === want);
    if (!target || target.isBot) { send(ws, { type: 'ERROR', message: 'You can only nudge players at your table.' }); return true; }
    if (String(target.username).toLowerCase() === String(found.name || '').toLowerCase()) return true;
    if (ws.userId && hasBlocked(ws.userId, target.username)) { send(ws, { type: 'ERROR', message: 'You blocked this player.' }); return true; }

    const now = Date.now();
    ws.__nudges = (ws.__nudges || []).filter(t => now - t < 60000);
    if (ws.__nudges.length >= PER_MINUTE) { send(ws, { type: 'ERROR', message: 'Easy on the nudges. Try again in a minute.' }); return true; }
    ws.__nudgedAt = ws.__nudgedAt || {};
    const last = ws.__nudgedAt[want] || 0;
    if (now - last < SAME_TARGET_MS) {
        send(ws, { type: 'ERROR', message: `You just nudged ${target.username}. Try again in ${Math.ceil((SAME_TARGET_MS - (now - last)) / 1000)}s.` });
        return true;
    }
    ws.__nudges.push(now);
    ws.__nudgedAt[want] = now;
    send(ws, { type: 'NUDGE_SENT', to: target.username });

    const tws = target.id;
    const tUid = tws && tws.userId;
    if (tUid && hasBlocked(tUid, found.name)) return true;          // they blocked the sender: silently dropped

    const yourTurn = ['playing', 'finalTurn'].includes(found.lobby.gameState) && found.lobby.currentTurnUser === target.username;
    const online = tws && tws.readyState === 1;
    if (online) send(tws, { type: 'NUDGED', code: found.lobby.code, from: found.name, yourTurn });
    // push when they can't see the game: socket gone, or the app is in the background
    if (tUid && (!online || tws.__appHidden)) pushNudge(tUid, found.name, found.lobby.code, yourTurn);
    return true;
}

module.exports = { handleNudgeMessage };
