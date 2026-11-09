// public/js/turnBanner.js - big turn banner top-centre of the table, just above the deck.
// Red + pulsing on your turn, dark pill with the player's name otherwise.
(function () {
    'use strict';
    if (window.__turnBannerLoaded) return;
    window.__turnBannerLoaded = true;

    var el = null, last = null;

    function ensure() {
        if (el && document.body.contains(el)) return el;
        el = document.createElement('div');
        el.id = 'pf-turn-banner';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
        return el;
    }

    function place() {
        if (!el || el.style.display === 'none') return;
        var deck = document.getElementById('deck-pile');
        if (!deck) { el.style.display = 'none'; return; }
        var r = deck.getBoundingClientRect();
        if (!r.width) { el.style.display = 'none'; return; }
        var h = el.offsetHeight || 28;
        var tb = document.getElementById('table-oval-container');
        var tr = tb && tb.getBoundingClientRect();
        el.style.left = Math.round(tr && tr.width ? tr.left + tr.width / 2 : r.left + r.width / 2) + 'px';
        el.style.top = Math.max(4, Math.round(r.top - h - 8)) + 'px';
    }

    function refresh(lobby) {
        var b = ensure();
        lobby = lobby || last; last = lobby;
        var gv = document.getElementById('game-view');
        var inGame = lobby && (lobby.gameState === 'playing' || lobby.gameState === 'finalTurn') && lobby.currentTurnUser;
        if (!inGame || (gv && gv.offsetParent === null)) { b.style.display = 'none'; return; }
        var me = (lobby.players || []).find(function (p) { return p.isMe && !p.isBot; });
        var mine = !!(me && !me.eliminated && lobby.currentTurnUser === me.username);
        var text = mine ? (lobby.gameState === 'finalTurn' ? 'YOUR FINAL TURN!' : 'YOUR TURN!') : (lobby.currentTurnUser + "'s turn");
        if (b.textContent !== text) b.textContent = text;
        b.className = mine ? 'pf-tb-mine' : 'pf-tb-other';
        b.style.display = 'block';
        place();
    }

    function wrap() {
        var orig = window.updateUIFromLobby;
        if (typeof orig !== 'function') return false;
        if (orig.__tbWrapped) return true;
        var w = function (lobby) {
            var r = orig.apply(this, arguments);
            try { refresh(lobby); } catch (e) {}
            return r;
        };
        w.__tbWrapped = true;
        window.updateUIFromLobby = w;
        return true;
    }
    var tries = 0, t = setInterval(function () { if (wrap() || ++tries > 100) clearInterval(t); }, 200);
    window.addEventListener('resize', function () { place(); });
    setInterval(place, 600);
    window.__turnBannerRefresh = refresh;
})();
