// public/js/rematch.js - "Play again?" prompt after a match.
//
// The server (server/rematch.js) sends every seated human { type:'REMATCH_PROMPT', code, winner, ready, total }
// once the table is back in the waiting room after a match, and { type:'REMATCH_STATUS', code, ready, total }
// whenever the list of ready players changes. "Play again" is the normal SET_READY; "Leave table" is the normal
// leaveLobby. The prompt closes by itself when the next game starts, when the table is left, or after 60 s.
// Names are inserted with textContent.
(function () {
    'use strict';
    if (window.__rematchLoaded) return;
    window.__rematchLoaded = true;

    var listenedWs = null, overlay = null, closeTimer = null, watchTimer = null;
    var current = null;   // { code, winner, ready, total, me: bool }

    function send(msg) {
        if (typeof window.sendSocket === 'function') return window.sendSocket(msg);
        if (typeof window.initSocketAndSend === 'function') return window.initSocketAndSend(msg);
    }
    function el(tag, css, text) {
        var n = document.createElement(tag);
        if (css) n.style.cssText = css;
        if (text !== undefined) n.textContent = text;
        return n;
    }
    function myName() {
        return String((window.clientState && window.clientState.username) ||
            (typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '') || '').toLowerCase();
    }

    function close() {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
        current = null;
    }

    function render() {
        if (!current) return;
        if (!overlay) {
            overlay = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10011;display:flex;align-items:center;justify-content:center;padding:16px;');
            overlay.id = 'rematch-modal';
            var box = el('div', 'max-width:340px;width:100%;background:#061c11;border:1px solid rgba(212,175,55,0.6);border-radius:10px;padding:16px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,0.7);');
            box.appendChild(el('h3', 'margin:0 0 8px;color:#fbbf24;', '🏆 Play again?'));
            var w = el('p', 'margin:0 0 10px;font-size:0.92rem;color:#e2e8f0;');
            w.id = 'rematch-winner';
            box.appendChild(w);
            var st = el('p', 'margin:0 0 14px;font-size:0.85rem;color:#94a3b8;');
            st.id = 'rematch-status';
            box.appendChild(st);
            var row = el('div', 'display:flex;gap:10px;justify-content:center;');
            var yes = el('button', 'padding:9px 16px;border-radius:6px;border:1px solid #059669;background:#10b981;color:#fff;font-weight:700;cursor:pointer;', 'Play again');
            yes.type = 'button'; yes.id = 'rematch-yes';
            yes.onclick = function () {
                if (!current) return;
                current.me = true;
                send({ type: 'SET_READY', ready: true, code: current.code });
                render();
            };
            var no = el('button', 'padding:9px 16px;border-radius:6px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;font-weight:700;cursor:pointer;', 'Leave table');
            no.type = 'button'; no.id = 'rematch-no';
            no.onclick = function () {
                close();
                if (typeof window.leaveLobby === 'function') window.leaveLobby(true);
                else send({ type: 'LEAVE_LOBBY' });
            };
            row.appendChild(yes); row.appendChild(no);
            box.appendChild(row);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
        }
        var winner = current.winner ? String(current.winner) : '';
        document.getElementById('rematch-winner').textContent = winner ? winner + ' won the match.' : 'The match is over.';
        var n = (current.ready || []).length, total = current.total || 0;
        var meReady = current.me || (current.ready || []).some(function (x) { return String(x).toLowerCase() === myName(); });
        var s = n + ' of ' + total + ' ready' + (meReady ? ' - waiting for the others' : '');
        document.getElementById('rematch-status').textContent = s;
        var yes2 = document.getElementById('rematch-yes');
        yes2.disabled = meReady;
        yes2.style.opacity = meReady ? '0.5' : '1';
        yes2.textContent = meReady ? "You're in" : 'Play again';
    }

    function open(data) {
        close();
        current = { code: data.code, winner: data.winner, ready: data.ready || [], total: data.total || 0, me: false };
        render();
        closeTimer = setTimeout(close, 60000);
        // go away when the next game starts or we are no longer in the waiting room of this table
        watchTimer = setInterval(function () {
            var snap = window.appGlobals && window.appGlobals.latestLobbySnapshot;
            if (!snap) return;
            if (snap.gameState && snap.gameState !== 'lobby') close();
            else if (snap.code && current && snap.code !== current.code) close();
        }, 700);
    }

    function onMessage(ev) {
        var data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (!data) return;
        if (data.type === 'REMATCH_PROMPT') open(data);
        else if (data.type === 'REMATCH_STATUS' && current && data.code === current.code) {
            current.ready = data.ready || [];
            current.total = data.total || current.total;
            render();
        } else if ((data.type === 'LEFT_LOBBY' || data.type === 'KICKED_FROM_LOBBY') && current) close();
    }

    function watchSocket() {
        var ws = (window.appGlobals && window.appGlobals.ws) || window.ws;
        if (ws && ws !== listenedWs && typeof ws.addEventListener === 'function') {
            ws.addEventListener('message', onMessage);
            listenedWs = ws;
        }
    }
    setInterval(watchSocket, 500);
    window.__rematchPrompt = open;   // console / tests
})();
