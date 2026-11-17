// public/js/dragDrop.js - click-and-drag / drop for cards (taps still work).
//   hand card (when you hold 4) ........ drop on the discard pile  -> discard it
//   deck / discard pile (when you hold 3) drop on your hand        -> draw from it
// Gating mirrors the rules: only on your turn in playing/finalTurn; the real actions are the existing
// window.drawCard / window.discardCard, so the server still validates everything.
(function () {
    'use strict';
    if (window.__dragDropLoaded) return;
    window.__dragDropLoaded = true;

    var HOLD_MS = 500;      // a card must be held this long before it can be dragged (quick swipes/taps do nothing new)
    var SLOP = 12;          // moving more than this before the hold ends cancels the drag
    var st = null;          // active gesture
    var suppressClick = false;

    function snap() { return window.appGlobals && window.appGlobals.latestLobbySnapshot; }
    function me(s) { return s && (s.players || []).find(function (p) { return p.isMe && !p.isBot; }); }

    // what could the local player drag right now?
    function mode() {
        var s = snap(), m = me(s);
        if (!s || !m || m.eliminated) return null;
        if (s.gameState !== 'playing' && s.gameState !== 'finalTurn') return null;
        if (s.currentTurnUser !== m.username) return null;
        if (document.body.classList.contains('da-hide-cards')) return null;
        if (s.dealingUntil && (s.dealingUntil > (s.serverNow || Date.now()))) return null;
        var n = (m.cards || []).length;
        return n >= 4 ? 'discard' : (n > 0 ? 'draw' : null);
    }
    function discardSlot() { return document.querySelector('#deck-center > .card-slot:not(#deck-pile)'); }
    function handBox() { return document.getElementById('my-cards-container'); }

    function expand(r, dx, dy) { return { left: r.left - dx, right: r.right + dx, top: r.top - dy, bottom: r.bottom + dy }; }
    function inside(r, x, y) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
    function zoneEl(g) { return g.kind === 'hand' ? discardSlot() : handBox(); }
    function zoneRect(g) {
        var el = zoneEl(g); if (!el) return null;
        var r = el.getBoundingClientRect();
        return g.kind === 'hand' ? expand(r, 34, 34) : expand(r, 24, 46);
    }

    function classify(target) {
        var m = mode(); if (!m) return null;
        var card = target.closest && target.closest('.my-card');
        if (card && m === 'discard') {
            var box = handBox(); if (!box) return null;
            var idx = Array.prototype.indexOf.call(box.querySelectorAll('.my-card'), card);
            return idx >= 0 ? { kind: 'hand', el: card, index: idx } : null;
        }
        if (m !== 'draw') return null;
        var deck = target.closest && target.closest('#deck-pile');
        if (deck) return { kind: 'deck', el: deck };
        var ds = discardSlot();
        if (ds && ds.contains(target) && ds.querySelector('.card-corner')) return { kind: 'discardPile', el: ds };
        return null;
    }

    // the card's look depends on where it sits (hand / deck styles), so copy its computed styles onto the clone
    function copyLook(src, dst) {
        try {
            var cs = getComputedStyle(src);
            for (var i = 0; i < cs.length; i++) { var k = cs[i]; dst.style.setProperty(k, cs.getPropertyValue(k)); }
        } catch (e) {}
        var a = src.children, b = dst.children;
        for (var j = 0; j < a.length && j < b.length; j++) copyLook(a[j], b[j]);
    }
    function makeGhost(el, x, y) {
        var r = el.getBoundingClientRect();
        var g = el.cloneNode(true);
        copyLook(el, g);
        g.removeAttribute('id'); g.removeAttribute('onclick');
        [].forEach.call(g.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
        g.classList.add('dd-ghost');
        ['transition', 'animation', 'transform', 'opacity', 'margin'].forEach(function (k) { g.style.removeProperty(k); });
        g.style.position = 'fixed'; g.style.zIndex = '9800'; g.style.pointerEvents = 'none';
        g.style.boxSizing = 'border-box';
        g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
        g.style.left = '0px'; g.style.top = '0px';
        document.body.appendChild(g);
        return { g: g, dx: x - r.left, dy: y - r.top, w: r.width, h: r.height };
    }
    function moveGhost(x, y) {
        var o = st.ghost;
        o.g.style.transform = 'translate(' + Math.round(x - o.dx) + 'px,' + Math.round(y - o.dy) + 'px)';   // same size as the card
    }
    function setTarget(on, over) {
        var z = zoneEl(st);
        if (!z) return;
        z.classList.toggle('dd-target', !!on);
        z.classList.toggle('dd-over', !!over);
    }
    function clearAll(g) {
        [].forEach.call(document.querySelectorAll('.dd-target,.dd-over'), function (n) { n.classList.remove('dd-target', 'dd-over'); });
        [].forEach.call(document.querySelectorAll('.dd-dragging'), function (n) { n.classList.remove('dd-dragging'); });
        document.body.classList.remove('dd-active');
        if (g && g.ghost && g.ghost.g.parentNode) g.ghost.g.parentNode.removeChild(g.ghost.g);
    }

    function down(ev) {
        if (st) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        var c = classify(ev.target);
        if (!c) return;
        st = { kind: c.kind, el: c.el, index: c.index, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY,
               started: false, armed: false, ghost: null, timer: null };
        var mine = st;
        // pick the card up only after it has been held still for HOLD_MS
        mine.timer = setTimeout(function () {
            if (st !== mine) return;
            mine.timer = null;
            if (!mode()) { st = null; return; }
            mine.armed = true;
            mine.started = true;
            mine.ghost = makeGhost(mine.el, mine.x0, mine.y0);
            moveGhost(mine.x, mine.y);
            mine.el.classList.add('dd-dragging');
            document.body.classList.add('dd-active');
            setTarget(true, false);
            try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
        }, HOLD_MS);
    }
    function move(ev) {
        if (!st || ev.pointerId !== st.id) return;
        st.x = ev.clientX; st.y = ev.clientY;
        if (!st.started) {
            // moved before the hold finished: not a drag (a tap/swipe as before)
            if (Math.abs(ev.clientX - st.x0) + Math.abs(ev.clientY - st.y0) > SLOP) { if (st.timer) clearTimeout(st.timer); st = null; }
            return;
        }
        ev.preventDefault();
        moveGhost(ev.clientX, ev.clientY);
        var zr = zoneRect(st);
        setTarget(true, !!zr && inside(zr, ev.clientX, ev.clientY));
    }
    function up(ev) {
        if (!st || ev.pointerId !== st.id) return;
        var s = st; st = null;
        if (s.timer) clearTimeout(s.timer);
        if (!s.started) return;                 // a plain tap: let the normal click run
        suppressClick = true; setTimeout(function () { suppressClick = false; }, 350);
        var zr = zoneRect(s);
        var hit = !!zr && inside(zr, ev.clientX, ev.clientY);
        clearAll(s);
        if (!hit || !mode()) return;            // dropped elsewhere: snaps back, nothing happens
        if (s.kind === 'hand') window.discardCard(s.index);
        else window.drawCard(s.kind === 'deck' ? 'deck' : 'discard');
    }
    function cancel(ev) {
        if (!st || (ev && ev.pointerId !== st.id)) return;
        var s = st; st = null;
        if (s.timer) clearTimeout(s.timer);
        if (s.started) clearAll(s);
    }

    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, { capture: true, passive: false });
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', cancel, true);
    // a drag must not also fire the tap action underneath
    document.addEventListener('click', function (ev) {
        if (suppressClick) { ev.stopPropagation(); ev.preventDefault(); }
    }, true);
    // block text selection / image drag while dragging
    document.addEventListener('dragstart', function (ev) { if (st) ev.preventDefault(); }, true);
    window.__dragDropMode = mode;   // tests
})();
