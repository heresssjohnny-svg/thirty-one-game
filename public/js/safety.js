// public/js/safety.js - block and report players.
// Tap a player's seat (or their name in chat) -> 🚫 Block / 🚩 Report. Settings -> "Blocked players" to unblock.
// A blocked player's chat, reactions, soundboard sounds, recorded cues and voice are hidden/muted on this device
// (the server also stops their emotes and friend requests). They are not told.
// Signed-in players' blocks live on the server (/api/safety/*); guests keep a local list on this device.
(function () {
    'use strict';
    if (window.__safetyLoaded) return;
    window.__safetyLoaded = true;

    var LS = '31_blocked_v1';
    var blocked = new Set();
    var shown = {};   // lowercase -> name as typed
    var REASONS = [['abuse', 'Abusive or hateful chat/voice'], ['cheating', 'Cheating or teaming up'], ['debt', 'Not paying what they owe'],
        ['name', 'Offensive username'], ['spam', 'Spam or flooding'], ['other', 'Something else']];

    function token() { try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; } }
    function signedIn() {
        var t = token(); if (!t) return false;
        try { var p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); var id = String(p.userId || p.id || ''); return !!id && !p.guest && id.indexOf('gst_') !== 0 && id.indexOf('usr_guest_') !== 0; }
        catch (e) { return true; }
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function low(s) { return String(s || '').trim().toLowerCase(); }
    function note(m) { if (typeof window.showCenterNotification === 'function') window.showCenterNotification(m); }
    function myName() { try { return low(typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : ''); } catch (e) { return ''; } }
    function isBlocked(name) { return !!name && blocked.has(low(name)); }
    window.isPlayerBlocked = isBlocked;

    function setList(names, save) {
        shown = {};
        (names || []).forEach(function (n) { if (low(n)) shown[low(n)] = String(n).trim(); });
        blocked = new Set(Object.keys(shown));
        if (save !== false) { try { localStorage.setItem(LS, JSON.stringify(Object.keys(shown).map(function (k) { return shown[k]; }))); } catch (e) {} }
        applyVoice(); rerender(); paintSettings();
    }
    try { setList(JSON.parse(localStorage.getItem(LS) || '[]'), false); } catch (e) {}

    function api(path, method, body) {
        return fetch('/api/safety/' + path, { method: method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: body ? JSON.stringify(body) : undefined })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); });
    }
    var lastTok = null;
    function load() {
        var t = token();
        if (!t || !signedIn()) { lastTok = t; return; }
        lastTok = t;
        api('blocks').then(function (d) {
            var server = (d.blocked || []).map(function (b) { return b.name; });
            // carry over anything blocked while signed out / as a guest
            var extra = Object.keys(shown).filter(function (n) { return server.map(low).indexOf(n) < 0; }).map(function (k) { return shown[k]; });
            extra.forEach(function (n) { api('block', 'POST', { username: n }).catch(function () {}); });
            setList(server.concat(extra));
        }).catch(function () {});
    }
    setTimeout(load, 800);
    setInterval(function () { if (token() !== lastTok) load(); }, 3000);

    function block(name) {
        name = String(name || '').trim(); if (!name) return Promise.resolve();
        if (!signedIn()) { var a = Object.keys(shown).map(function (k) { return shown[k]; }); a.push(name); setList(a); return Promise.resolve(); }
        return api('block', 'POST', { username: name }).then(function (d) { setList((d.blocked || []).map(function (b) { return b.name; })); });
    }
    function unblock(name) {
        if (!signedIn()) { setList(Object.keys(shown).filter(function (k) { return k !== low(name); }).map(function (k) { return shown[k]; })); return Promise.resolve(); }
        return api('unblock', 'POST', { username: name }).then(function (d) { setList((d.blocked || []).map(function (b) { return b.name; })); });
    }

    // ---- filter what a blocked player sends -------------------------------------------------
    function filterSnap(s) {
        if (!s || !blocked.size) return s;
        try {
            if (Array.isArray(s.chatHistory)) s.chatHistory = s.chatHistory.filter(function (m) { return !isBlocked(m && (m.user || m.username)); });
            var rx = s.lastReaction;
            if (rx && rx.id && isBlocked(rx.username) && window.appGlobals) window.appGlobals.lastRenderedReactionId = rx.id;
            (s.players || []).forEach(function (p) { if (p && isBlocked(p.username) && p.celebration) p.celebration = {}; });
        } catch (e) {}
        return s;
    }
    function wrapUI() {
        var o = window.updateUIFromLobby;
        if (typeof o !== 'function' || o.__safety) return;
        var w = function (s) { return o.apply(this, [filterSnap(s)].concat([].slice.call(arguments, 1))); };
        w.__safety = true; window.updateUIFromLobby = w;
    }
    function wrapChat() {
        var o = window.syncChatHistory;
        if (typeof o !== 'function' || o.__safety) return;
        var w = function (h) {
            var list = Array.isArray(h) ? h.filter(function (m) { return !isBlocked(m && (m.user || m.username)); }) : h;
            var r = o.call(this, list);
            tagChat(); return r;
        };
        w.__safety = true; window.syncChatHistory = w;
    }
    function tagChat() {
        var box = document.getElementById('chat-messages') || document.getElementById('chat-box');
        if (!box) return;
        box.querySelectorAll('.chat-line strong:not([data-sf-name])').forEach(function (el) {
            var n = el.textContent.replace(/:\s*$/, '').trim();
            el.setAttribute('data-sf-name', n);
            if (low(n) !== myName()) { el.style.cursor = 'pointer'; el.title = 'Block or report'; }
        });
    }
    function rerender() {
        var s = window.appGlobals && window.appGlobals.latestLobbySnapshot;
        if (s && Array.isArray(s.chatHistory) && typeof window.syncChatHistory === 'function') { try { window.syncChatHistory(s.chatHistory); } catch (e) {} }
    }
    function applyVoice() {
        document.querySelectorAll('audio.lk-remote-audio[data-identity]').forEach(function (a) {
            var b = isBlocked(a.getAttribute('data-identity'));
            if (b && !a.muted) { a.muted = true; a.setAttribute('data-sf-muted', '1'); }
            else if (!b && a.getAttribute('data-sf-muted')) { a.muted = false; a.removeAttribute('data-sf-muted'); }
        });
    }
    setInterval(function () { wrapUI(); wrapChat(); wrapTap(); applyVoice(); ensureSettings(); watchSocket(); }, 700);
    wrapUI(); wrapChat();

    var hooked = null;
    function watchSocket() {
        var ws = window.appGlobals && window.appGlobals.ws;
        if (!ws || ws === hooked) return;
        hooked = ws;
        ws.addEventListener('message', function (ev) {
            var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
            if (d && d.type === 'BLOCKS_CHANGED' && Array.isArray(d.blocked)) setList(d.blocked);
        });
    }

    // ---- UI ----------------------------------------------------------------------------------
    function css() {
        if (document.getElementById('sf-css')) return;
        var st = document.createElement('style'); st.id = 'sf-css';
        st.textContent =
            '#sf-modal{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center;}' +
            '#sf-sheet{width:100%;max-width:440px;max-height:88vh;overflow:auto;background:#0f172a;border:1px solid #334155;border-radius:16px 16px 0 0;padding:16px;color:#e2e8f0;font-size:.9rem;box-sizing:border-box;}' +
            '#sf-sheet h4{margin:0 0 4px;color:#fbbf24;font-size:1.05rem;}#sf-sheet p{margin:0 0 12px;color:#94a3b8;font-size:.78rem;}' +
            '.sf-btn{display:block;width:100%;padding:11px;margin-top:8px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#f8fafc;font-weight:700;font-size:.9rem;cursor:pointer;}' +
            '.sf-btn.red{background:#7f1d1d;border-color:#b91c1c;}.sf-btn.ghost{background:transparent;color:#94a3b8;}' +
            '.sf-r{display:flex;align-items:center;gap:8px;padding:8px;margin-top:6px;border-radius:8px;background:#1e293b;cursor:pointer;}' +
            '#sf-sheet textarea{width:100%;box-sizing:border-box;margin-top:10px;min-height:64px;border-radius:8px;border:1px solid #334155;background:#020617;color:#f8fafc;padding:8px;font:inherit;}' +
            '.sf-row-actions{display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.15);}' +
            '.sf-row-actions button{flex:1;font-size:.75rem;padding:6px;}';
        document.head.appendChild(st);
    }
    function sheet(html) {
        css();
        var m = document.getElementById('sf-modal');
        if (!m) {
            m = document.createElement('div'); m.id = 'sf-modal';
            m.addEventListener('click', function (ev) { if (ev.target === m || (ev.target.closest && ev.target.closest('[data-sf-close]'))) close(); });
            document.body.appendChild(m);
        }
        m.innerHTML = '<div id="sf-sheet" role="dialog">' + html + '</div>';
        return m;
    }
    function close() { var m = document.getElementById('sf-modal'); if (m) m.remove(); }

    function openActions(name) {
        if (!name || low(name) === myName()) return;
        var b = isBlocked(name);
        var m = sheet('<h4>' + esc(name) + '</h4><p>' + (b ? 'You have blocked this player.' :
            'Blocking hides their chat, reactions, sounds and emotes and mutes their voice for you. They are not told.') + '</p>' +
            (b ? '<button type="button" class="sf-btn" data-sf-unblock>✅ Unblock</button>' : '<button type="button" class="sf-btn red" data-sf-block>🚫 Block</button>') +
            '<button type="button" class="sf-btn" data-sf-report>🚩 Report to admins</button>' +
            '<button type="button" class="sf-btn ghost" data-sf-close>Cancel</button>');
        m.querySelector('#sf-sheet').addEventListener('click', function (ev) {
            var t = ev.target.closest ? ev.target.closest('button') : null; if (!t) return;
            if (t.hasAttribute('data-sf-block')) { block(name).then(function () { close(); note('🚫 Blocked ' + name); }).catch(function (e) { note(e.message); }); }
            else if (t.hasAttribute('data-sf-unblock')) { unblock(name).then(function () { close(); note('✅ Unblocked ' + name); }).catch(function (e) { note(e.message); }); }
            else if (t.hasAttribute('data-sf-report')) openReport(name);
        });
    }
    window.openPlayerSafety = openActions;

    function openReport(name) {
        if (!signedIn()) {
            sheet('<h4>🚩 Report ' + esc(name) + '</h4><p>Sign in to an account to send reports. You can still block them on this device.</p>' +
                '<button type="button" class="sf-btn ghost" data-sf-close>Close</button>');
            return;
        }
        var m = sheet('<h4>🚩 Report ' + esc(name) + '</h4><p>The admins will see this with their recent chat at your table.</p>' +
            REASONS.map(function (r) { return '<label class="sf-r"><input type="radio" name="sf-reason" value="' + r[0] + '"> ' + esc(r[1]) + '</label>'; }).join('') +
            '<textarea id="sf-details" maxlength="500" placeholder="What happened? (optional)"></textarea>' +
            (isBlocked(name) ? '' : '<label class="sf-r"><input type="checkbox" id="sf-also" checked> Also block them</label>') +
            '<button type="button" class="sf-btn red" data-sf-send>Send report</button><button type="button" class="sf-btn ghost" data-sf-close>Cancel</button>');
        m.querySelector('[data-sf-send]').addEventListener('click', function (ev) {
            var r = m.querySelector('input[name="sf-reason"]:checked');
            if (!r) { note('Pick a reason.'); return; }
            var also = m.querySelector('#sf-also');
            ev.target.disabled = true;
            api('report', 'POST', { username: name, reason: r.value, details: (m.querySelector('#sf-details') || {}).value || '', block: !!(also && also.checked) })
                .then(function (d) { if (d.blocked) setList(d.blocked.map(function (b) { return b.name; })); close(); note('🚩 Report sent. Thanks for letting us know.'); })
                .catch(function (e) { ev.target.disabled = false; note(e.message); });
        });
    }

    // seat taps: add Block / Report to the existing seat popup, or open our own when there is none
    function isBot(name) {
        var s = window.appGlobals && window.appGlobals.latestLobbySnapshot;
        var p = s && (s.players || []).find(function (x) { return x && low(x.username) === low(name); });
        return !!(p && p.isBot);
    }
    function visible(id) { var e = document.getElementById(id); return !!(e && e.style.display !== 'none' && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none'); }
    function wrapTap() {
        var o = window.tapSeat;
        if (typeof o !== 'function' || o.__safety) return;
        var w = function (name) {
            var before = { s: visible('seat-action-modal'), b: visible('bet-modal') };
            var r = o.apply(this, arguments);
            try {
                if (!name || low(name) === myName() || isBot(name)) return r;
                var body = null;
                if (!before.s && visible('seat-action-modal')) body = document.getElementById('seat-action-body');
                else if (!before.b && visible('bet-modal')) body = document.getElementById('bet-modal-body');
                if (body) {
                    if (!body.querySelector('.sf-row-actions')) {
                        css();
                        var row = document.createElement('div'); row.className = 'sf-row-actions';
                        row.innerHTML = '<button type="button" style="background:#475569;" data-sf-seat="block">' + (isBlocked(name) ? '✅ Unblock' : '🚫 Block') + '</button>' +
                            '<button type="button" style="background:#7f1d1d;" data-sf-seat="report">🚩 Report</button>';
                        row.setAttribute('data-sf-for', String(name));
                        body.appendChild(row);
                    }
                } else openActions(name);
            } catch (e) {}
            return r;
        };
        w.__safety = true; window.tapSeat = w;
    }
    document.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target : null; if (!t) return;
        var seatBtn = t.closest('[data-sf-seat]');
        if (seatBtn) {
            var name = seatBtn.parentNode.getAttribute('data-sf-for');
            if (typeof window.toggleModal === 'function') { window.toggleModal('seat-action-modal', false); window.toggleModal('bet-modal', false); }
            if (seatBtn.getAttribute('data-sf-seat') === 'report') openReport(name); else openActions(name);
            return;
        }
        var chatName = t.closest('.chat-line strong[data-sf-name]');
        if (chatName && low(chatName.getAttribute('data-sf-name')) !== myName()) openActions(chatName.getAttribute('data-sf-name'));
        var ub = t.closest('[data-sf-unb]');
        if (ub) unblock(ub.getAttribute('data-sf-unb')).then(function () { note('✅ Unblocked ' + ub.getAttribute('data-sf-unb')); }).catch(function (e) { note(e.message); });
    });

    // ---- Settings: blocked players -------------------------------------------------------------
    var sec = null, lastPaint = '';
    function ensureSettings() {
        if (sec && document.body.contains(sec)) return;
        var content = document.querySelector('#settings-modal .settings-content');
        if (!content) return;
        sec = document.createElement('div'); sec.id = 'sf-settings';
        content.appendChild(sec); lastPaint = ''; paintSettings();
    }
    function paintSettings() {
        if (!sec) return;
        var list = Object.keys(shown).sort().map(function (k) { return shown[k]; });
        var key = list.join('|'); if (key === lastPaint) return; lastPaint = key;
        sec.innerHTML = '<div style="font-weight:800;color:#fbbf24;margin:14px 0 2px;">🚫 Blocked players</div>' +
            (list.length ? list.map(function (n) {
                return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;margin-top:4px;background:rgba(0,0,0,.25);border-radius:6px;font-size:.85rem;">' +
                    '<span>' + esc(n) + '</span><button type="button" data-sf-unb="' + esc(n) + '" style="font-size:.72rem;padding:3px 8px;background:#475569;">Unblock</button></div>';
            }).join('') : '<div style="font-size:.78rem;color:#94a3b8;">Nobody. Tap a player\'s seat or their name in chat to block or report them.</div>');
    }
})();
