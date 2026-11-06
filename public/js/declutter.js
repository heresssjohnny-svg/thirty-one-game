// public/js/declutter.js - small helpers for a calmer game screen (pairs with css/declutter.css).
//  - skips routine banner messages the screen already shows another way (deck / discard pick-ups)
//  - measures the header and hand so notices sit below the header / above the hand, not on top of them
//  - restarts the fade-out of the knock pill and pick-up chips when their content changes
//  - tags my own seat so its duplicate mini hand can be hidden while playing
(function () {
    'use strict';
    if (window.__declutterLoaded) return;
    window.__declutterLoaded = true;

    var ROUTINE = /picked up (a card from the deck|.+ from the discard pile)/i;
    var lastKeys = {};

    function wrapNotification() {
        var orig = window.showCenterNotification;
        if (typeof orig !== 'function' || orig.__dcWrapped) return typeof orig === 'function';
        var w = function (message, ms) {
            if (typeof message === 'string' && ROUTINE.test(message)) return;
            return orig.call(this, message, Math.min(ms || 3200, 2400));
        };
        w.__dcWrapped = true;
        window.showCenterNotification = w;
        return true;
    }

    function restartFade(id) {
        var el = document.getElementById(id);
        if (!el || el.style.display === 'none') { delete lastKeys[id]; return; }
        var key = el.textContent + '|' + (el.innerHTML.length);
        if (lastKeys[id] === key) return;
        lastKeys[id] = key;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
    }

    function measure() {
        var root = document.documentElement.style;
        // everything above the felt (title, buttons rows) ends where the table begins
        var tbl = document.querySelector('.table-outer-wrapper');
        if (tbl) {
            var tt = tbl.getBoundingClientRect().top;
            if (tt > 0) root.setProperty('--dc-header-bottom', Math.round(tt) + 'px');
        }
        var hand = document.querySelector('.player-hand-container');
        if (hand) {
            var ht = hand.getBoundingClientRect().top;
            if (ht > 0) root.setProperty('--dc-chip-bottom', Math.round(window.innerHeight - ht + 4) + 'px');
        }
    }

    function refresh(lobby) {
        if (!lobby) return;
        document.body.setAttribute('data-dc-state', lobby.gameState || '');
        var me = (lobby.players || []).find(function (p) { return p.isMe && !p.isBot; });
        var mine = me ? String(me.username).toLowerCase() : null;
        document.querySelectorAll('[data-player-username]').forEach(function (el) {
            el.classList.toggle('dc-mine', !!mine && String(el.getAttribute('data-player-username')).toLowerCase() === mine);
        });
        measure();
        restartFade('knock-alert-modal');
        restartFade('discard-pickup-topleft-modal');
        restartFade('fed-card-topright-modal');
    }

    function wrapUpdate() {
        var orig = window.updateUIFromLobby;
        if (typeof orig !== 'function') return false;
        if (orig.__dcWrapped) return true;
        var w = function (lobby) {
            var r = orig.apply(this, arguments);
            try { refresh(lobby); } catch (e) {}
            return r;
        };
        w.__dcWrapped = true;
        window.updateUIFromLobby = w;
        return true;
    }

    var tries = 0;
    var t = setInterval(function () {
        var a = wrapUpdate(), b = wrapNotification();
        if ((a && b) || ++tries > 100) clearInterval(t);
    }, 200);
    window.addEventListener('resize', measure);
    window.__declutterRefresh = refresh;
})();
