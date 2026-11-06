// public/js/muck.js - "Muck" button: after someone knocks, on your final turn you can throw in
// your hand. The round ends at once and you lose a life (server/game/muck.js).
(function () {
    'use strict';
    if (window.__muckLoaded) return;
    window.__muckLoaded = true;

    var btn = null;

    function send(msg) {
        if (typeof window.sendSocket === 'function') return window.sendSocket(msg);
        if (typeof window.initSocketAndSend === 'function') return window.initSocketAndSend(msg);
    }

    function ensureButton() {
        if (btn && document.body.contains(btn)) return btn;
        var knock = document.getElementById('knock-btn');
        if (!knock || !knock.parentNode) return null;
        btn = document.createElement('button');
        btn.id = 'muck-btn';
        btn.type = 'button';
        btn.className = knock.className;
        btn.textContent = 'Muck 🗑️';
        btn.title = 'Throw in your hand and take the loss';
        btn.style.cssText = 'display:none;margin-left:8px;background:#475569;';
        btn.addEventListener('click', function () {
            if (!window.confirm('Muck your hand? The round ends and you lose a life.')) return;
            btn.style.display = 'none';
            send({ type: 'MUCK' });
        });
        knock.parentNode.insertBefore(btn, knock.nextSibling);
        return btn;
    }

    function refresh(lobby) {
        var b = ensureButton();
        if (!b) return;
        var me = lobby && (lobby.players || []).find(function (p) { return p.isMe && !p.isBot; });
        var show = !!(lobby && lobby.gameState === 'finalTurn' && me && !me.eliminated &&
            lobby.knockedBy && lobby.knockedBy !== me.username && lobby.currentTurnUser === me.username);
        b.style.display = show ? '' : 'none';
    }

    function wrap() {
        var orig = window.updateUIFromLobby;
        if (typeof orig !== 'function') return false;
        if (orig.__muckWrapped) return true;
        var wrapped = function (lobby) {
            var r = orig.apply(this, arguments);
            try { refresh(lobby); } catch (e) {}
            return r;
        };
        wrapped.__muckWrapped = true;
        window.updateUIFromLobby = wrapped;
        return true;
    }
    var tries = 0;
    var t = setInterval(function () { if (wrap() || ++tries > 100) clearInterval(t); }, 200);
    window.__muckRefresh = refresh;
})();
