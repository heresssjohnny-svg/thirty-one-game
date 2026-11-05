// public/js/privateTabs.js - Public / Private tabs in "Live Tables", and the host's join-request prompt.
// Loaded last. Public tab = the normal list. Private tab = every private table (asked from the server with
// GET_PRIVATE_TABLES). A friend of the host joins directly; anyone else taps "Ask to join" and the host gets an
// Allow / Deny prompt. When the host allows, this player joins and becomes the host's friend (server side).
// Names and table names from the server are inserted with textContent.
(function () {
    'use strict';
    if (window.__privateTabsLoaded) return;
    window.__privateTabsLoaded = true;

    var tab = 'public';
    var listenedWs = null;
    var rows = [];
    var askedCodes = {};          // code -> true while waiting for the host
    var queue = [], shown = false;

    function $(id) { return document.getElementById(id); }
    function el(tag, css, text) {
        var n = document.createElement(tag);
        if (css) n.style.cssText = css;
        if (text !== undefined) n.textContent = text;
        return n;
    }
    function send(msg) {
        if (typeof window.initSocketAndSend === 'function') return window.initSocketAndSend(msg);
        if (typeof window.sendSocket === 'function') return window.sendSocket(msg);
    }

    var card = document.querySelector('#main-menu .public-lobbies-card');
    var pubList = $('lobby-list');
    if (!card || !pubList) return;

    // ---- tab bar + private list container ---------------------------------------------------
    var bar = el('div', 'display:flex;gap:6px;margin:6px 0 8px;');
    function tabBtn(id, label) {
        var b = el('button', 'flex:1;padding:6px 8px;border-radius:6px;font-weight:700;font-size:.82rem;cursor:pointer;', label);
        b.type = 'button'; b.id = id;
        return b;
    }
    var bPub = tabBtn('tab-public-tables', 'Public');
    var bPriv = tabBtn('tab-private-tables', 'Private');
    bar.appendChild(bPub); bar.appendChild(bPriv);
    bar.id = 'tables-tabs';

    var privBox = el('div', 'display:none;');
    privBox.id = 'private-lobby-list';
    var status = el('div', 'min-height:1.1em;margin:4px 0;font-size:.78rem;color:#fbbf24;');
    status.id = 'private-tables-status';

    var head = card.querySelector('.card-header-flex');
    if (head && head.nextSibling) card.insertBefore(bar, head.nextSibling); else card.insertBefore(bar, pubList);
    card.insertBefore(status, pubList);
    pubList.parentNode.insertBefore(privBox, pubList.nextSibling);

    function say(msg, bad) { status.textContent = msg || ''; status.style.color = bad ? '#f87171' : '#fbbf24'; }

    function paintTabs() {
        var on = 'background:#d97706;border:1px solid #fbbf24;color:#fff;';
        var off = 'background:rgba(0,0,0,.35);border:1px solid rgba(251,191,36,.3);color:#cbd5e1;';
        var base = 'flex:1;padding:6px 8px;border-radius:6px;font-weight:700;font-size:.82rem;cursor:pointer;';
        bPub.style.cssText = base + (tab === 'public' ? on : off);
        bPriv.style.cssText = base + (tab === 'private' ? on : off);
        pubList.style.display = tab === 'public' ? '' : 'none';
        privBox.style.display = tab === 'private' ? '' : 'none';
    }

    function refresh() { if (tab === 'private') send({ type: 'GET_PRIVATE_TABLES' }); }

    function setTab(t) {
        tab = t; paintTabs(); say('');
        if (t === 'private') {
            if (!privBox.firstChild) privBox.appendChild(el('div', 'text-align:center;color:#94a3b8;padding:12px;font-size:.85rem;', 'Loading private tables…'));
            refresh();
        }
    }
    bPub.addEventListener('click', function () { setTab('public'); });
    bPriv.addEventListener('click', function () { setTab('private'); });
    var rf = card.querySelector('.refresh-btn');
    if (rf) rf.addEventListener('click', refresh);

    // ---- private list ------------------------------------------------------------------------
    function paintList(signedIn) {
        privBox.textContent = '';
        if (!signedIn) {
            privBox.appendChild(el('div', 'text-align:center;color:#94a3b8;padding:12px;font-size:.85rem;',
                'Private tables are for players with an account. Log in or register to see them.'));
            return;
        }
        if (!rows.length) {
            privBox.appendChild(el('div', 'text-align:center;color:#94a3b8;padding:12px;font-size:.85rem;', 'No private tables right now.'));
            return;
        }
        rows.forEach(function (t) {
            var item = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;background:rgba(0,0,0,.35);' +
                'border:1px solid rgba(251,191,36,.3);border-radius:8px;padding:8px 12px;margin-bottom:6px;');
            item.className = 'lobby-item private-lobby-item';
            var info = el('div');
            var title = el('div', 'font-weight:700;color:#f8fafc;font-size:.9rem;', (t.name || 'Table') + ' ');
            title.appendChild(el('span', 'color:#fbbf24;font-size:.78rem;', '[' + (t.code || '') + ']'));
            var sub = el('div', 'font-size:.75rem;color:#94a3b8;',
                'Host: ' + (t.host || '?') + ' • ' + (t.count || 0) + '/' + (t.maxPlayers || 6) + ' • ' +
                (t.state === 'lobby' ? 'Waiting' : 'In Game'));
            info.appendChild(title); info.appendChild(sub);

            var direct = !!(t.friend || t.mine);
            var waiting = !!askedCodes[t.code];
            var b = el('button', 'border:none;border-radius:6px;padding:6px 12px;font-weight:700;cursor:pointer;font-size:.8rem;color:#fff;' +
                'background:' + (direct ? '#10b981' : '#d97706') + ';',
                direct ? 'Join' : (waiting ? 'Waiting…' : 'Ask to join'));
            b.type = 'button';
            b.dataset.code = t.code;
            b.dataset.direct = direct ? '1' : '0';
            b.disabled = waiting && !direct;
            b.addEventListener('click', function () {
                if (direct) { if (typeof window.joinLobbyCode === 'function') window.joinLobbyCode(t.code); return; }
                askedCodes[t.code] = true;
                b.disabled = true; b.textContent = 'Waiting…';
                send({ type: 'REQUEST_JOIN', code: t.code });
            });
            item.appendChild(info); item.appendChild(b);
            privBox.appendChild(item);
        });
    }

    // ---- host prompt -------------------------------------------------------------------------
    function showRequest(item) {
        shown = true;
        var overlay = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10015;display:flex;align-items:center;justify-content:center;padding:16px;');
        overlay.id = 'join-request-modal';
        var box = el('div', 'max-width:360px;width:100%;background:#061c11;border:1px solid rgba(212,175,55,.6);border-radius:10px;padding:16px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.7);');
        box.appendChild(el('h3', 'margin:0 0 10px;color:#fbbf24;', '🔑 Join request'));
        var msg = el('p', 'margin:0 0 6px;font-size:.92rem;color:#e2e8f0;line-height:1.45;');
        msg.appendChild(el('strong', 'color:#fff;', item.username));
        msg.appendChild(document.createTextNode(' wants to join your private table.'));
        box.appendChild(msg);
        box.appendChild(el('p', 'margin:0 0 14px;font-size:.78rem;color:#94a3b8;', 'If you allow it, they become your friend.'));
        var row = el('div', 'display:flex;gap:10px;justify-content:center;');
        function done(allow) {
            send({ type: 'RESPOND_JOIN_REQUEST', requestId: item.requestId, allow: allow });
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            shown = false; next();
        }
        var ok = el('button', 'padding:9px 18px;border-radius:6px;border:1px solid #059669;background:#10b981;color:#fff;font-weight:700;cursor:pointer;', 'Allow');
        ok.type = 'button'; ok.id = 'join-allow-btn'; ok.onclick = function () { done(true); };
        var no = el('button', 'padding:9px 18px;border-radius:6px;border:1px solid #b91c1c;background:#dc2626;color:#fff;font-weight:700;cursor:pointer;', 'Deny');
        no.type = 'button'; no.id = 'join-deny-btn'; no.onclick = function () { done(false); };
        row.appendChild(ok); row.appendChild(no);
        box.appendChild(row); overlay.appendChild(box);
        document.body.appendChild(overlay);
    }
    function next() { if (!shown && queue.length) showRequest(queue.shift()); }

    // ---- socket messages ---------------------------------------------------------------------
    function onMessage(ev) {
        var d;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d) return;
        if (d.type === 'PRIVATE_TABLES') {
            rows = Array.isArray(d.tables) ? d.tables : [];
            if (tab === 'private') paintList(d.signedIn !== false);
        } else if (d.type === 'JOIN_REQUEST_SENT') {
            askedCodes[d.code] = true;
            say('Request sent to ' + (d.host || 'the host') + '. Waiting for them to let you in…');
        } else if (d.type === 'JOIN_APPROVED') {
            delete askedCodes[d.code];
            say('');
            if (typeof window.joinLobbyCode === 'function') window.joinLobbyCode(d.code);
        } else if (d.type === 'JOIN_DENIED') {
            delete askedCodes[d.code];
            say(d.expired ? 'The host did not answer. You can ask again.' : 'The host declined your request.', true);
            refresh();
        } else if (d.type === 'JOIN_REQUEST') {
            if (d.requestId && d.username) { queue.push(d); next(); }
        } else if (d.type === 'ERROR' && tab === 'private') {
            // clear any "Waiting" button so the player can try again
            askedCodes = {}; refresh();
        }
    }
    function watch() {
        var ws = (window.appGlobals && window.appGlobals.ws) || window.ws;
        if (ws && ws !== listenedWs && typeof ws.addEventListener === 'function') {
            ws.addEventListener('message', onMessage);
            listenedWs = ws;
        }
    }
    setInterval(watch, 500); watch();
    window.__privateTabsMessage = function (d) { onMessage({ data: JSON.stringify(d) }); };   // console / tests

    function menuVisible() {
        var m = $('main-menu');
        return !!m && m.style.display !== 'none' && m.getClientRects().length > 0;
    }
    setInterval(function () { if (tab === 'private' && menuVisible()) refresh(); }, 5000);
    paintTabs();
})();
