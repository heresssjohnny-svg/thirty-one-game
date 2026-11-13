// public/js/autoUpdate.js - reload open games after a new version is deployed.
// The server reports a version id (/api/version, a hash of the page files taken when it starts). After a deploy the
// server restarts, sockets reconnect, and we check again; we also check every 2 minutes and when the app comes back
// to the foreground. When the version changed we reload at a safe moment only:
//   - not seated at a table, or the table is between matches (lobby / match over), or between hands when not in voice;
//   - not typing (a text box with something in it), not in the report/block sheet.
// While waiting, a small bar says "Update ready" with a "Refresh now" button. Reloading puts you back at your table.
(function () {
    'use strict';
    if (window.__autoUpdateLoaded) return;
    window.__autoUpdateLoaded = true;

    var base = null, pending = false, bar = null, countdown = null, lastWs = null, safeSince = 0;
    var GUARD = 'blitz31_au_reload_at';

    function fetchVersion() {
        return fetch('/api/version?t=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { return d && d.v ? String(d.v) : null; })
            .catch(function () { return null; });
    }
    function check() {
        fetchVersion().then(function (v) {
            if (!v) return;
            if (!base) { base = v; return; }
            if (v !== base && !pending) { pending = true; tick(); }
        });
    }

    function snap() { return (window.appGlobals && window.appGlobals.latestLobbySnapshot) || null; }
    function me() { try { return String(typeof window.getActiveUsername === 'function' ? window.getActiveUsername() : '').toLowerCase(); } catch (e) { return ''; } }
    function inVoice() { try { return typeof isLiveKitConnected !== 'undefined' && !!isLiveKitConnected; } catch (e) { return false; } }
    function seated(s) {
        var n = me(); if (!n || !s) return false;
        return (s.players || []).some(function (p) { return p && !p.isBot && String(p.username || '').toLowerCase() === n; });
    }
    function gameSafe() {
        var s = snap();
        if (!s || !seated(s)) return true;
        var st = s.state || s.gameState;
        if (st === 'lobby' || st === 'tournamentEnd' || st === 'mainMenu' || st === 'suspended') return true;
        if (st === 'roundOver' && !inVoice()) return true;
        return false;
    }
    function busy() {
        var a = document.activeElement;
        if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|email|password|number|tel|url)?$/i.test(a.type || ''))) && String(a.value || '').trim()) return true;
        if (document.getElementById('sf-modal')) return true;
        return false;
    }

    function reloadNow() {
        try { sessionStorage.setItem(GUARD, String(Date.now())); } catch (e) {}
        var go = function () { window.location.reload(); };
        try {
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
                navigator.serviceWorker.getRegistration().then(function (r) { return r && r.update ? r.update() : null; })
                    .catch(function () {}).then(go);
                setTimeout(go, 2500);
                return;
            }
        } catch (e) {}
        go();
    }
    function recentlyReloaded() {
        try { return Date.now() - Number(sessionStorage.getItem(GUARD) || 0) < 60000; } catch (e) { return false; }
    }

    function css() {
        if (document.getElementById('au-css')) return;
        var st = document.createElement('style'); st.id = 'au-css';
        st.textContent = '#au-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(10px + env(safe-area-inset-bottom));z-index:100002;' +
            'display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:999px;background:#0f172a;border:1px solid #fbbf24;color:#f8fafc;' +
            'font-size:.8rem;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.5);width:max-content;max-width:calc(100vw - 24px);box-sizing:border-box;white-space:nowrap;}' +
            '#au-bar button{border:0;border-radius:999px;padding:5px 10px;background:#fbbf24;color:#0f172a;font-weight:800;font-size:.75rem;cursor:pointer;}' +
            '#au-bar .au-x{background:transparent;color:#94a3b8;padding:2px 4px;}';
        document.head.appendChild(st);
    }
    function showBar(text, withButton) {
        css();
        if (!bar) {
            bar = document.createElement('div'); bar.id = 'au-bar'; bar.setAttribute('role', 'status');
            bar.addEventListener('click', function (ev) {
                var b = ev.target.closest && ev.target.closest('button'); if (!b) return;
                if (b.hasAttribute('data-au-now')) reloadNow();
                if (b.hasAttribute('data-au-x')) { bar.style.display = 'none'; bar.__hidden = true; }
            });
            document.body.appendChild(bar);
        }
        var key = text + '|' + withButton;
        if (bar.__key !== key) {
            bar.__key = key;
            bar.innerHTML = '<span>' + text + '</span>' + (withButton ? '<button type="button" data-au-now>Refresh now</button><button type="button" class="au-x" data-au-x aria-label="Hide">✕</button>' : '');
        }
        if (!bar.__hidden) bar.style.display = 'flex';
    }

    function tick() {
        if (!pending) return;
        if (recentlyReloaded()) { showBar('🔄 Update ready', true); return; }
        var ok = gameSafe() && !busy();
        if (!ok) { safeSince = 0; if (countdown) { clearTimeout(countdown); countdown = null; } showBar(gameSafe() ? '🔄 Updating in a moment' : '🔄 Update after this game', true); return; }
        if (!safeSince) safeSince = Date.now();
        if (document.hidden) { reloadNow(); return; }
        if (Date.now() - safeSince < 1500) return;          // let a just-finished round settle
        if (!countdown) {
            if (bar) bar.__hidden = false;
            showBar('🔄 Updating Blitz 31…', false);
            countdown = setTimeout(function () { countdown = null; if (gameSafe() && !busy()) reloadNow(); else tick(); }, 2500);
        }
    }

    // after a deploy the server restarts and the socket reconnects: check right away when a new socket opens
    function watchSocket() {
        var ws = window.appGlobals && window.appGlobals.ws;
        if (!ws || ws === lastWs) return;
        lastWs = ws;
        var fire = function () { setTimeout(check, 1500); };
        if (ws.readyState === 1) fire(); else ws.addEventListener('open', fire);
    }

    check();
    setInterval(check, 120000);
    setInterval(function () { watchSocket(); tick(); }, 2000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); else tick(); });
    window.addEventListener('online', check);
    window.__autoUpdate = { check: check, state: function () { return { base: base, pending: pending, safe: gameSafe(), busy: busy() }; } };
})();
