// public/js/nudge.js - 👋 Nudge a player (button in the player menu, added by safety.js) and receive nudges.
// Sends APP_STATE {hidden} so the server only sends a push notification when your game isn't on screen.
// NUDGED -> phone buzzes, a hand waves across the screen with "<name> nudged you!" (shown when you come back if the
// app was in the background).
(function () {
    'use strict';
    if (window.__nudgeLoaded) return;
    window.__nudgeLoaded = true;

    var lastWs = null, waiting = null;

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function sock() { return window.appGlobals && window.appGlobals.ws; }
    function sendRaw(obj) {
        var ws = sock();
        if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); return true; } catch (e) {} }
        return false;
    }
    function reportState() { sendRaw({ type: 'APP_STATE', hidden: !!document.hidden }); }

    window.nudgePlayer = function (name) {
        if (!name) return;
        if (typeof window.sendSocket === 'function') window.sendSocket({ type: 'NUDGE', to: name });
        else sendRaw({ type: 'NUDGE', to: name });
    };
    window.canNudge = function (name) {
        var s = window.appGlobals && window.appGlobals.latestLobbySnapshot;
        var me = String(typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '').toLowerCase();
        if (!s || !name || String(name).toLowerCase() === me) return false;
        return (s.players || []).some(function (p) { return p && !p.isBot && String(p.username || '').toLowerCase() === String(name).toLowerCase(); });
    };

    function css() {
        if (document.getElementById('nd-css')) return;
        var st = document.createElement('style'); st.id = 'nd-css';
        st.textContent = '.nd-over{position:fixed;inset:0;z-index:100003;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(251,191,36,.18),transparent 65%);animation:ndFade 2.6s ease-out forwards;}' +
            '.nd-hand{font-size:min(38vw,200px);line-height:1;transform-origin:70% 85%;animation:ndWave .5s ease-in-out 4 alternate;filter:drop-shadow(0 8px 24px rgba(0,0,0,.6));}' +
            '.nd-txt{margin-top:10px;padding:6px 16px;border-radius:999px;background:rgba(15,23,42,.9);border:1px solid #fbbf24;color:#fbbf24;font-weight:900;font-size:1.05rem;text-align:center;}' +
            '.nd-sub{display:block;font-size:.8rem;color:#f8fafc;font-weight:700;}' +
            '@keyframes ndWave{from{transform:rotate(-18deg);}to{transform:rotate(22deg);}}' +
            '@keyframes ndFade{0%{opacity:0;}8%,80%{opacity:1;}100%{opacity:0;}}' +
            'body.nd-buzz #game-view{animation:ndBuzz .4s linear 2;}' +
            '@keyframes ndBuzz{0%,100%{transform:translateX(0);}25%{transform:translateX(-5px);}75%{transform:translateX(5px);}}' +
            '@media (prefers-reduced-motion:reduce){.nd-hand,body.nd-buzz #game-view{animation:none!important;}}';
        document.head.appendChild(st);
    }
    function showNudge(d) {
        css();
        try { if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 350]); } catch (e) {}
        try {
            var a = document.getElementById('sound-yourturn');
            if (a) { a.currentTime = 0; var p = a.play(); if (p && p.catch) p.catch(function () {}); }
        } catch (e) {}
        var o = document.createElement('div'); o.className = 'nd-over';
        o.innerHTML = '<div class="nd-hand">👋</div><div class="nd-txt">' + esc(d.from) + ' nudged you!' +
            (d.yourTurn ? '<span class="nd-sub">It\'s your turn</span>' : '') + '</div>';
        document.body.appendChild(o);
        document.body.classList.remove('nd-buzz'); void document.body.offsetWidth; document.body.classList.add('nd-buzz');
        setTimeout(function () { document.body.classList.remove('nd-buzz'); }, 900);
        setTimeout(function () { o.remove(); }, 2700);
    }
    window.__showNudge = showNudge;   // tests

    function onMsg(ev) {
        var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d || !d.type) return;
        if (d.type === 'NUDGED') {
            if (document.hidden) waiting = d;          // the push notification covers it; show it when they come back
            else showNudge(d);
        } else if (d.type === 'NUDGE_SENT') {
            if (typeof window.showCenterNotification === 'function') window.showCenterNotification('👋 Nudged ' + d.to);
        }
    }
    function watch() {
        var ws = sock();
        if (!ws || ws === lastWs) return;
        lastWs = ws;
        ws.addEventListener('message', onMsg);
        if (ws.readyState === 1) reportState(); else ws.addEventListener('open', reportState);
    }
    document.addEventListener('visibilitychange', function () {
        reportState();
        if (!document.hidden && waiting) { var d = waiting; waiting = null; setTimeout(function () { showNudge(d); }, 300); }
    });
    window.addEventListener('pagehide', function () { sendRaw({ type: 'APP_STATE', hidden: true }); });
    setInterval(watch, 700);
    watch();
})();
