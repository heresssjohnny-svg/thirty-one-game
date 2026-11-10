// server/tableStyle.js - Premium host perk: rename the table and pick a theme everyone at the table sees.
//   SET_TABLE_STYLE {name?, theme?}  host (or admin) with Premium only; theme null/'' = players' own styles.
// lobby.name is the table name (escaped by the client); lobby.tableTheme goes out in the snapshot.
const { statusFor } = require('./premium');
const THEMES = ['classic', 'vegas', 'speakeasy', 'neon', 'riverboat', 'spooky', 'holiday'];

function send(ws, o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} }
function handleTableStyle(ws, msg, lobbyManager, broadcastLobbyList) {
    if (!msg || msg.type !== 'SET_TABLE_STYLE') return false;
    const lobbies = lobbyManager.lobbies || {};
    const lobby = Object.values(lobbies).find(l => l && ((l.players || []).some(p => p && p.id === ws) || (l.spectators || []).some(s => s && s.idSocket === ws)));
    if (!lobby) return true;
    if (!lobbyManager.isLobbyHost(lobby, ws, ws.currentUsername)) { send(ws, { type: 'ERROR', message: 'Only the host can change the table style.' }); return true; }
    if (!statusFor(ws.userId).premium) { send(ws, { type: 'ERROR', message: '🔒 Table styles are Premium.' }); return true; }
    if (msg.name != null) {
        const name = String(msg.name).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
        if (name) lobby.name = name;
    }
    if (msg.theme !== undefined) lobby.tableTheme = THEMES.includes(String(msg.theme)) ? String(msg.theme) : null;
    try { lobbyManager.broadcastLobbyUpdate(lobby.code); } catch (e) {}
    if (typeof broadcastLobbyList === 'function') { try { broadcastLobbyList(); } catch (e) {} }
    return true;
}
module.exports = { handleTableStyle, THEMES };
