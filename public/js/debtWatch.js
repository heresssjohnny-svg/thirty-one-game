// public/js/debtWatch.js - host prompt when a player with a large unpaid balance joins the table.
//
// The server (server/debtWatch.js) sends the host { type: 'DEBT_WARNING', username, owed } when someone whose
// lifetime net balance is below -$50 sits down or starts watching. The host sees
//   "<user> has joined the table but has a non-payment balance of $X"
// with Allow (just closes the prompt) and Kick (sends the usual ADMIN_KICK_PLAYER message).
// Several warnings queue up and are shown one at a time. Names are inserted with textContent.

(function () {
    if (window.__debtWatchInstalled) return;
    window.__debtWatchInstalled = true;

    const queue = [];
    let shown = false;
    let listenedWs = null;

    function send(msg) {
        if (typeof window.sendSocket === 'function') return window.sendSocket(msg);
        if (typeof window.initSocketAndSend === 'function') return window.initSocketAndSend(msg);
    }

    function money(n) {
        const v = Number(n) || 0;
        return '$' + (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(2));
    }

    function el(tag, css, text) {
        const e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function close(overlay) {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        shown = false;
        next();
    }

    function show(item) {
        shown = true;
        const overlay = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10010;display:flex;align-items:center;justify-content:center;padding:16px;');
        overlay.id = 'debt-warning-modal';
        const box = el('div', 'max-width:360px;width:100%;background:#061c11;border:1px solid rgba(212,175,55,0.6);border-radius:10px;padding:16px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,0.7);');
        box.appendChild(el('h3', 'margin:0 0 10px;color:#fbbf24;', '⚠️ Unpaid balance'));

        const msg = el('p', 'margin:0 0 16px;font-size:0.92rem;color:#e2e8f0;line-height:1.45;');
        const name = el('strong', 'color:#fff;', item.username);
        msg.appendChild(name);
        msg.appendChild(document.createTextNode(' has joined the table but has a non-payment balance of '));
        msg.appendChild(el('strong', 'color:#f87171;', money(item.owed)));
        msg.appendChild(document.createTextNode('.'));
        box.appendChild(msg);

        const row = el('div', 'display:flex;gap:10px;justify-content:center;');
        const allow = el('button', 'padding:9px 18px;border-radius:6px;border:1px solid #059669;background:#10b981;color:#fff;font-weight:700;cursor:pointer;', 'Allow');
        allow.type = 'button';
        allow.id = 'debt-allow-btn';
        allow.onclick = () => close(overlay);
        const kick = el('button', 'padding:9px 18px;border-radius:6px;border:1px solid #b91c1c;background:#dc2626;color:#fff;font-weight:700;cursor:pointer;', 'Kick');
        kick.type = 'button';
        kick.id = 'debt-kick-btn';
        kick.onclick = () => {
            send({ type: 'ADMIN_KICK_PLAYER', targetUsername: item.username });
            close(overlay);
        };
        row.appendChild(allow);
        row.appendChild(kick);
        box.appendChild(row);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }

    function next() {
        if (shown || !queue.length) return;
        show(queue.shift());
    }

    function onWarning(data) {
        if (!data || !data.username) return;
        const key = String(data.username).toLowerCase();
        if (queue.some(q => String(q.username).toLowerCase() === key)) return;   // already waiting
        queue.push({ username: String(data.username), owed: data.owed });
        next();
    }

    function onSocketMessage(ev) {
        let data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (data && data.type === 'DEBT_WARNING') onWarning(data);
    }

    function watchSocket() {
        const ws = (window.appGlobals && window.appGlobals.ws) || window.ws;
        if (ws && ws !== listenedWs && typeof ws.addEventListener === 'function') {
            ws.addEventListener('message', onSocketMessage);
            listenedWs = ws;
        }
    }
    setInterval(watchSocket, 500);
    window.__debtWarning = onWarning;   // console / tests
})();
