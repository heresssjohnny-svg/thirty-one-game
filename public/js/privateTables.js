// public/js/privateTables.js - public tables are free play, private tables are friends-only with wagers.
// Loaded last (after invite.js). It does four small things:
//   1. Marks a join that came from an invite link (viaInvite:true) so the server makes you the host's friend.
//   2. Shows the terms + "I am 18 or older" prompt when the server answers TERMS_REQUIRED, then resends the
//      join / create that was held.
//   3. Hides the wager controls on public tables (the server also refuses stakes there) and explains why.
//   4. Adds a one-line explanation under the "Private Table" checkbox.
(function () {
    'use strict';
    if (window.__privateTablesLoaded) return;
    window.__privateTablesLoaded = true;

    var PENDING_KEY = 'blitz31_pending_join';
    var VIA_KEY = 'blitz31_via_invite';
    var info = {};          // code -> isPrivate (from TABLE_INFO)
    var held = null;        // the join / create message waiting for the terms
    var listenedWs = null;

    function $(id) { return document.getElementById(id); }
    function sget(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
    function sset(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
    function sdel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
    function token() {
        try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; }
    }
    function el(tag, css, text) {
        var n = document.createElement(tag);
        if (css) n.style.cssText = css;
        if (text !== undefined) n.textContent = text;
        return n;
    }
    function cleanCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }

    // ---- 1. invite-link joins ----------------------------------------------------------------
    var pending = cleanCode(sget(PENDING_KEY));
    if (pending.length >= 4) sset(VIA_KEY, pending);

    function leaveRoomMemory() {
        try { localStorage.removeItem('blitz31_active_room'); } catch (e) {}
        if (window.appGlobals) window.appGlobals.currentJoinedCode = null;
    }

    function wrapSender() {
        var orig = window.initSocketAndSend;
        if (typeof orig !== 'function' || orig.__privateWrapped) return;
        var wrapped = function (msg) {
            try {
                if (msg && msg.type === 'JOIN_LOBBY') {
                    if (cleanCode(sget(VIA_KEY)) === cleanCode(msg.code)) {
                        msg.viaInvite = true;
                        sdel(VIA_KEY);
                    }
                    held = JSON.parse(JSON.stringify(msg));
                } else if (msg && msg.type === 'CREATE_LOBBY') {
                    held = JSON.parse(JSON.stringify(msg));
                }
            } catch (e) {}
            return orig.apply(this, arguments);
        };
        wrapped.__privateWrapped = true;
        window.initSocketAndSend = wrapped;
    }

    // ---- 2. terms + age prompt ---------------------------------------------------------------
    function closeTerms() { var m = $('terms-modal'); if (m && m.parentNode) m.parentNode.removeChild(m); }

    function showTerms() {
        if ($('terms-modal')) return;
        var action = held;
        var overlay = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:10020;display:flex;align-items:center;justify-content:center;padding:14px;');
        overlay.id = 'terms-modal';
        var box = el('div', 'max-width:420px;width:100%;max-height:88vh;overflow:auto;background:#061c11;border:1px solid rgba(212,175,55,.6);' +
            'border-radius:10px;padding:16px;box-shadow:0 8px 30px rgba(0,0,0,.7);');
        var h = el('h3', 'margin:0 0 10px;color:#fbbf24;', 'Private table terms');
        var textBox = el('div', 'font-size:.84rem;color:#e2e8f0;line-height:1.45;');
        textBox.appendChild(el('p', 'margin:0;color:#94a3b8;', 'Loading…'));
        var label = el('label', 'display:flex;gap:8px;align-items:flex-start;margin:12px 0;font-size:.86rem;color:#fde68a;cursor:pointer;');
        var cb = el('input'); cb.type = 'checkbox'; cb.id = 'terms-over18'; cb.style.marginTop = '3px';
        label.appendChild(cb); label.appendChild(el('span', '', 'I am 18 or older and I accept these terms.'));
        var err = el('div', 'min-height:1.1em;font-size:.78rem;color:#f87171;margin-bottom:6px;');
        var row = el('div', 'display:flex;gap:10px;justify-content:flex-end;');
        var cancel = el('button', '', 'Cancel'); cancel.type = 'button'; cancel.id = 'terms-cancel-btn'; cancel.className = 'secondary-btn';
        var ok = el('button', '', 'Accept & continue'); ok.type = 'button'; ok.id = 'terms-accept-btn'; ok.className = 'primary-btn gold-btn';
        ok.disabled = true;
        row.appendChild(cancel); row.appendChild(ok);
        box.appendChild(h); box.appendChild(textBox); box.appendChild(label); box.appendChild(err); box.appendChild(row);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var version = 'v1';
        fetch('/api/terms', { headers: { Authorization: 'Bearer ' + token() }, cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (t) {
                version = t.version || version;
                textBox.textContent = '';
                (t.paragraphs || []).forEach(function (p) { textBox.appendChild(el('p', 'margin:0 0 8px;', p)); });
            })
            .catch(function () { textBox.textContent = 'Could not load the terms. Please try again.'; });

        cb.addEventListener('change', function () { ok.disabled = !cb.checked; });
        cancel.addEventListener('click', function () { leaveRoomMemory(); held = null; closeTerms(); });
        ok.addEventListener('click', function () {
            ok.disabled = true; err.textContent = '';
            fetch('/api/terms/accept', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ over18: true, version: version })
            }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
              .then(function (res) {
                  if (!res.ok) { err.textContent = (res.j && res.j.error) || 'Could not save that. Please try again.'; ok.disabled = !cb.checked; return; }
                  closeTerms();
                  if (action && typeof window.initSocketAndSend === 'function') window.initSocketAndSend(action);
              })
              .catch(function () { err.textContent = 'Connection problem. Please try again.'; ok.disabled = !cb.checked; });
        });
    }

    // ---- socket messages ---------------------------------------------------------------------
    function onSocketMessage(ev) {
        var d;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d) return;
        if (d.type === 'TERMS_REQUIRED') showTerms();
        else if (d.type === 'TABLE_INFO' && d.code) info[String(d.code).toUpperCase()] = !!d.isPrivate;
        else if (d.type === 'ERROR' && /private table for friends/i.test(d.message || '')) leaveRoomMemory();
    }
    function watchSocket() {
        wrapSender();
        var ws = (window.appGlobals && window.appGlobals.ws) || window.ws;
        if (ws && ws !== listenedWs && typeof ws.addEventListener === 'function') {
            ws.addEventListener('message', onSocketMessage);
            listenedWs = ws;
        }
    }
    setInterval(watchSocket, 500);
    watchSocket();
    window.__privateTablesMessage = function (d) { onSocketMessage({ data: JSON.stringify(d) }); };   // console / tests

    // ---- 3 + 4. UI explanations ---------------------------------------------------------------
    function currentCode() {
        var g = window.appGlobals || {};
        return cleanCode(g.currentJoinedCode || (g.latestLobbySnapshot && g.latestLobbySnapshot.code) || '');
    }
    function tidy() {
        // explanation under the Private Table checkbox (once)
        var box = $('private-lobby-checkbox');
        if (box && !$('private-table-hint')) {
            var grp = box.closest('.checkbox-group') || box.parentNode;
            var hint = el('div', 'font-size:.74rem;color:#94a3b8;margin:4px 0 0;line-height:1.35;',
                'Private tables are for friends and can use wagers (18+). Public tables are free play.');
            hint.id = 'private-table-hint';
            if (grp && grp.parentNode) grp.parentNode.insertBefore(hint, grp.nextSibling);
        }
        // wager controls only on private tables
        var code = currentCode();
        var isPublic = code && info[code] === false;
        var wagerSel = $('config-wager');
        var items = [];
        if (wagerSel && wagerSel.closest) items.push(wagerSel.closest('.config-item'));
        items.push($('config-table-type-item'));
        items.forEach(function (it) { if (it) it.style.display = isPublic ? 'none' : ''; });
        var bar = $('lobby-config-bar'), note = $('public-free-note');
        if (isPublic && bar) {
            if (!note) {
                note = el('div', 'flex-basis:100%;font-size:.78rem;color:#94a3b8;', 'Public table: free play. Create a private table to play with friends and wagers.');
                note.id = 'public-free-note';
                bar.appendChild(note);
            }
            note.style.display = '';
        } else if (note) {
            note.style.display = 'none';
        }
    }
    setInterval(tidy, 600);

    // ---- host: move a seated player to the spectators (waiting room) -------------------------
    function wrapTapSeat() {
        var orig = window.tapSeat;
        if (typeof orig !== 'function' || orig.__moveWrapped) return;
        var wrapped = function (name) {
            var r = orig.apply(this, arguments);
            try {
                var cs = window.clientState || {};
                var body = $('seat-action-body');
                var modal = $('seat-action-modal');
                if (cs.gameState === 'lobby' && body && modal && modal.style.display !== 'none' &&
                    /host controls/i.test(($('seat-action-title') || {}).innerText || '') && !body.querySelector('[data-move-spec]')) {
                    var b = el('button', 'margin-top:8px;width:100%;font-size:.75rem;padding:6px;background:#475569;', '🪑 Move to spectators');
                    b.type = 'button';
                    b.setAttribute('data-move-spec', String(name || ''));
                    body.insertBefore(b, body.firstChild);
                }
            } catch (e) {}
            return r;
        };
        wrapped.__moveWrapped = true;
        window.tapSeat = wrapped;
    }
    document.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-move-spec]') : null;
        if (!t) return;
        var name = t.getAttribute('data-move-spec');
        if (!name) return;
        if (typeof window.initSocketAndSend === 'function') window.initSocketAndSend({ type: 'ADMIN_MOVE_TO_SPECTATOR', targetUsername: name });
        if (typeof window.toggleModal === 'function') window.toggleModal('seat-action-modal', false);
    });
    setInterval(wrapTapSeat, 600);
})();
