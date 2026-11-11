// public/js/muck.js - "Muck" button: after someone knocks, on your final turn you can throw in
// your hand. You still play your final turn; if nobody hits 31 you lose a life and your cards stay hidden.
// Mucked players get a 🗑️ MUCKED tag on their seat.
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
            if (!window.confirm('Muck your hand? You still play this turn, then you lose a life at the end of the round unless someone hits 31. Your cards stay hidden.')) return;
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
        var show = !!(lobby && lobby.gameState === 'finalTurn' && me && !me.eliminated && !me.mucked &&
            lobby.knockedBy && lobby.knockedBy !== me.username && lobby.currentTurnUser === me.username);
        b.style.display = show ? '' : 'none';
        tagSeats(lobby);
    }
    // 🗑️ MUCKED tag on the seat of anyone who mucked this round (seats are re-rendered, so re-apply)
    function tagSeats(lobby) {
        var muck = {};
        var live = lobby && ['finalTurn', 'roundOver', 'tournamentEnd'].indexOf(lobby.gameState) >= 0;
        (lobby && lobby.players || []).forEach(function (p) { if (live && p.mucked) muck[String(p.username).toLowerCase()] = 1; });
        [].forEach.call(document.querySelectorAll('[data-player-username]'), function (el) {
            var on = !!muck[String(el.getAttribute('data-player-username') || '').toLowerCase()];
            var tag = el.querySelector(':scope > .muck-tag');
            if (on && !tag) {
                tag = document.createElement('div');
                tag.className = 'muck-tag';
                tag.textContent = '🗑️ MUCKED';
                tag.style.cssText = 'position:absolute;left:50%;top:-10px;transform:translateX(-50%);z-index:5;background:#475569;color:#fff;border:1px solid #cbd5e1;border-radius:999px;padding:1px 8px;font-size:0.65rem;font-weight:900;letter-spacing:0.04em;white-space:nowrap;pointer-events:none;';
                if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
                el.appendChild(tag);
            } else if (!on && tag) tag.remove();
        });
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
