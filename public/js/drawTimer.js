// public/js/drawTimer.js - 30-second clock on the dealer draw and the tie-breaker draw.
// The server (lobbyManager ensureDrawTimer) picks a random card for anyone who hasn't picked in time and sends
// drawMsLeft / drawAutoPicked in the snapshot. This shows the countdown in the open draw window, tags auto-picked
// players with ⏱, and tells you when a card was picked for you.
(function () {
    'use strict';
    if (window.__drawTimerLoaded) return;
    window.__drawTimerLoaded = true;

    var deadline = null, needMe = false, iv = null, toldPool = '';

    function me() { try { return String(typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '').toLowerCase(); } catch (e) { return ''; } }
    function css() {
        if (document.getElementById('dt-css')) return;
        var st = document.createElement('style'); st.id = 'dt-css';
        st.textContent = '.dt-chip{display:flex;justify-content:center;align-items:center;gap:6px;margin:4px auto 8px;padding:5px 12px;width:max-content;' +
            'border-radius:999px;font-weight:800;font-size:.85rem;background:rgba(0,0,0,.35);border:1px solid #475569;color:#e2e8f0;}' +
            '.dt-chip.dt-me{border-color:#fbbf24;color:#fbbf24;}.dt-chip.dt-low{border-color:#ef4444;color:#fca5a5;animation:dtPulse 1s infinite;}' +
            '@keyframes dtPulse{50%{transform:scale(1.06);}}.dt-auto{font-size:.7em;margin-left:3px;}';
        document.head.appendChild(st);
    }
    function box(state) {
        var id = state === 'dealerDraw' ? 'dealer-draw-modal' : 'tie-breaker-reveal-modal';
        var m = document.getElementById(id);
        return m ? (m.querySelector('.modal-box') || m) : null;
    }
    function chipFor(state) {
        var b = box(state); if (!b) return null;
        var c = b.querySelector('.dt-chip');
        if (!c) {
            css(); c = document.createElement('div'); c.className = 'dt-chip';
            var h = b.querySelector('.modal-header');
            if (h && h.nextSibling) b.insertBefore(c, h.nextSibling); else b.insertBefore(c, b.firstChild);
        }
        return c;
    }
    function hideAll() {
        document.querySelectorAll('.dt-chip').forEach(function (c) { c.style.display = 'none'; });
        deadline = null;
        if (iv) { clearInterval(iv); iv = null; }
    }
    var curState = null;
    function paint() {
        if (deadline == null || !curState) { hideAll(); return; }
        var c = chipFor(curState); if (!c) return;
        var secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        c.style.display = 'flex';
        c.className = 'dt-chip' + (needMe ? ' dt-me' : '') + (secs <= 10 ? ' dt-low' : '');
        c.textContent = secs > 0
            ? (needMe ? '⏱ Pick a card · ' + secs + 's' : '⏱ ' + secs + 's to pick')
            : (needMe ? '⏱ Picking a card for you…' : '⏱ Picking for anyone left…');
    }

    function onSnap(s) {
        if (!s) return hideAll();
        var st = s.gameState || s.state;
        if (st !== 'dealerDraw' && st !== 'tieBreaker') { curState = null; return hideAll(); }
        curState = st;
        var other = st === 'dealerDraw' ? 'tieBreaker' : 'dealerDraw';
        var oc = box(other) && box(other).querySelector('.dt-chip'); if (oc) oc.style.display = 'none';

        var n = me(), res = s.drawResults || {};
        var mine = Object.keys(res).some(function (k) { return k.toLowerCase() === n; });
        if (st === 'dealerDraw') needMe = !mine && (s.players || []).some(function (p) { return p && !p.eliminated && String(p.username || '').toLowerCase() === n; });
        else needMe = !mine && (s.tiedParticipantsList || []).some(function (u) { return String(u).toLowerCase() === n; });

        if (typeof s.drawMsLeft === 'number') {
            deadline = Date.now() + s.drawMsLeft;
            if (!iv) iv = setInterval(paint, 250);
            paint();
        } else {
            deadline = null; if (iv) { clearInterval(iv); iv = null; }
            var c = box(st) && box(st).querySelector('.dt-chip'); if (c) c.style.display = 'none';
        }

        var auto = (s.drawAutoPicked || []).map(function (u) { return String(u).toLowerCase(); });
        if (auto.length) {
            document.querySelectorAll('.draw-picker-badge').forEach(function (b) {
                var name = b.textContent.replace(/🤖|⏱/g, '').trim().toLowerCase();
                if (auto.indexOf(name) >= 0 && !b.querySelector('.dt-auto')) {
                    var t = document.createElement('span'); t.className = 'dt-auto'; t.textContent = '⏱'; t.title = 'Time ran out, picked for them';
                    b.appendChild(t);
                }
            });
            var poolKey = st + '|' + (s.drawPool || []).length + '|' + auto.join(',');
            if (auto.indexOf(n) >= 0 && toldPool !== poolKey) {
                toldPool = poolKey;
                if (typeof window.showCenterNotification === 'function') window.showCenterNotification('⏱ Time ran out, a card was picked for you.');
            }
        }
    }

    // wrap once (safety.js keeps itself outermost; wrapping again here would make the two re-wrap each other forever)
    var wrapped = false;
    function wrap() {
        var o = window.updateUIFromLobby;
        if (wrapped || typeof o !== 'function') return;
        var w = function (s) { var r = o.apply(this, arguments); try { onSnap(s); } catch (e) {} return r; };
        w.__drawTimer = true; window.updateUIFromLobby = w; wrapped = true;
    }
    wrap();
    var tries = setInterval(function () { wrap(); if (wrapped) clearInterval(tries); }, 500);
    window.__drawTimer = { onSnap: onSnap };
})();
