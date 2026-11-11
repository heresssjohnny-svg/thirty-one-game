// public/js/invite.js - invite links, the in-game Share button and "Play vs Bots" guest start.
// Loaded last. Uses only existing globals (joinLobbyCode, initSocketAndSend, saveStoredAuthToken,
// updateViewForAuth, authenticateActiveSocket, logoutSession, switchAuthTab) and degrades quietly
// when one is missing.
(function () {
    'use strict';
    if (window.__inviteLoaded) return;
    window.__inviteLoaded = true;

    var PENDING_KEY = 'blitz31_pending_join';
    var BOT_GAME_KEY = 'blitz31_start_bot_game';
    var GUEST_PREFIX = 'usr_guest_';

    function $(id) { return document.getElementById(id); }
    function cleanCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
    function store(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
    function read(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
    function drop(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

    function toast(msg) {
        if (typeof window.showCenterNotification === 'function') {
            try { window.showCenterNotification(msg); return; } catch (e) {}
        }
        var t = $('invite-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'invite-toast';
            t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#065f46;' +
                'color:#fff;border:1.5px solid #fbbf24;padding:10px 16px;border-radius:8px;font-weight:700;' +
                'font-size:0.9rem;z-index:99999;box-shadow:0 8px 25px rgba(0,0,0,.7);display:none;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.display = 'block';
        clearTimeout(t._h);
        t._h = setTimeout(function () { t.style.display = 'none'; }, 2600);
    }

    // ---------------------------------------------------------
    // 1. READ ?join=CODE FROM THE LINK
    // ---------------------------------------------------------
    try {
        var params = new URLSearchParams(location.search);
        var linked = cleanCode(params.get('join'));
        if (linked.length >= 4) {
            store(PENDING_KEY, linked);
            // The invite wins over auto-rejoining whatever table was open last time
            try { localStorage.removeItem('blitz31_active_room'); } catch (e) {}
            if (window.appGlobals) window.appGlobals.currentJoinedCode = null;
        }
        if (params.has('join')) {
            params.delete('join');
            var rest = params.toString();
            history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
        }
    } catch (e) {}

    function pendingCode() { return cleanCode(read(PENDING_KEY)); }

    function menuVisible() {
        var m = $('main-menu');
        return !!(m && m.style.display && m.style.display !== 'none');
    }
    function gameVisible() {
        var g = $('game-view');
        return !!(g && g.style.display === 'flex');
    }
    function authVisible() {
        var a = $('auth-screen');
        return !!(a && a.style.display !== 'none' && getComputedStyle(a).display !== 'none');
    }
    function me() {
        return window.userSession || null;
    }
    function isGuest() {
        var u = me();
        return !!(u && String(u.id || u.userId || '').indexOf(GUEST_PREFIX) === 0);
    }

    // ---------------------------------------------------------
    // 2. AUTH SCREEN: invite banner + guest button
    // ---------------------------------------------------------
    function ensureAuthExtras() {
        var card = document.querySelector('#auth-screen .auth-card');
        if (!card || !authVisible()) return;

        var code = pendingCode();
        var banner = $('invite-banner');
        if (code && !banner) {
            banner = document.createElement('div');
            banner.id = 'invite-banner';
            banner.style.cssText = 'margin:0 0 14px;padding:10px 12px;border:1px solid rgba(251,191,36,.6);' +
                'border-radius:8px;background:rgba(251,191,36,.12);color:#fde68a;font-size:.88rem;text-align:center;';
            var header = card.querySelector('.auth-header');
            if (header && header.nextSibling) card.insertBefore(banner, header.nextSibling);
            else card.insertBefore(banner, card.firstChild);
        }
        if (banner) {
            if (code) {
                banner.textContent = '🎴 You’ve been invited to table ' + code +
                    '. Log in, register, or play as a guest to join.';
                banner.style.display = 'block';
            } else {
                banner.style.display = 'none';
            }
        }

        if (!$('guest-play-box')) {
            var box = document.createElement('div');
            box.id = 'guest-play-box';
            box.style.cssText = 'margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.12);text-align:center;';
            var btn = document.createElement('button');
            btn.id = 'guest-play-btn';
            btn.style.cssText = 'width:100%;padding:11px 14px;border-radius:8px;border:1.5px solid #d97706;' +
                'background:rgba(217,119,6,.12);color:#fbbf24;font-weight:700;font-size:.92rem;cursor:pointer;';
            btn.type = 'button';
            btn.onclick = startGuest;
            var note = document.createElement('div');
            note.style.cssText = 'margin-top:6px;font-size:.76rem;color:#94a3b8;';
            note.textContent = 'No sign-up. Free tables only, with no wagers or balances.';
            box.appendChild(btn);
            box.appendChild(note);
            card.appendChild(box);
        }
        var gb = $('guest-play-btn');
        if (gb && !gb.disabled) {
            gb.textContent = code ? '▶ Join as Guest (no sign-up)' : '▶ Play vs Bots — no sign-up';
        }
    }

    function authError(msg) {
        if (typeof window.showAuthError === 'function') window.showAuthError(msg);
        else if (typeof showAuthError === 'function') showAuthError(msg);
        else alert(msg);
    }

    async function startGuest() {
        var btn = $('guest-play-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
        try {
            var res = await fetch('/auth/guest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok || !data.token) {
                authError(data.error || 'Could not start a guest game. Please try again.');
                return;
            }
            // Guests stay signed in for this tab only
            if (typeof saveStoredAuthToken === 'function') saveStoredAuthToken(data.token, false);
            else store('31_jwt', data.token);
            window.userSession = data.user;
            if (!pendingCode()) store(BOT_GAME_KEY, '1');
            if (typeof updateViewForAuth === 'function') updateViewForAuth(data.user);
            if (typeof authenticateActiveSocket === 'function') authenticateActiveSocket(data.token, data.user);
        } catch (e) {
            authError('Server communication error. Please try again.');
        } finally {
            if (btn) { btn.disabled = false; }
        }
    }
    window.startGuestGame = startGuest;

    // ---------------------------------------------------------
    // 3. AFTER LOGIN: join the invited table, or set up the bot game
    // ---------------------------------------------------------
    var creatingBotGame = false;
    var botsFor = null;

    function tick() {
        ensureAuthExtras();
        ensureShareButton();
        ensureGuestPill();

        if (!menuVisible() && !gameVisible()) return;

        // (a) invited table
        var code = pendingCode();
        if (code && menuVisible() && typeof window.joinLobbyCode === 'function') {
            drop(PENDING_KEY);
            drop(BOT_GAME_KEY);
            window.joinLobbyCode(code);
            return;
        }

        // (b) guest "Play vs Bots": create a private practice table, then add two bots
        if (read(BOT_GAME_KEY) === '1' && isGuest()) {
            if (menuVisible() && !creatingBotGame && typeof window.initSocketAndSend === 'function') {
                creatingBotGame = true;
                var name = me().username || 'Guest';
                window.initSocketAndSend({
                    type: 'CREATE_LOBBY',
                    username: name,
                    accountUsername: name,
                    lobbyName: 'Practice – ' + name,
                    isPrivate: true
                });
            }
            var snap = window.appGlobals && window.appGlobals.latestLobbySnapshot;
            if (creatingBotGame && snap && snap.code && botsFor !== snap.code) {
                botsFor = snap.code;
                drop(BOT_GAME_KEY);
                var humans = (snap.players || []).filter(function (p) { return !p.isBot; }).length;
                var wanted = Math.max(0, 3 - humans - (snap.players || []).filter(function (p) { return p.isBot; }).length);
                for (var i = 0; i < wanted; i++) window.initSocketAndSend({ type: 'ADD_BOT' });
            }
        }
    }

    // ---------------------------------------------------------
    // 4. IN-GAME SHARE BUTTON
    // ---------------------------------------------------------
    function currentCode() {
        var g = window.appGlobals || {};
        return cleanCode(g.currentJoinedCode || (g.latestLobbySnapshot && g.latestLobbySnapshot.code) ||
            localStorage.getItem('blitz31_active_room'));
    }

    function inviteUrl(code) {
        return location.origin + '/?join=' + encodeURIComponent(code) + (window.__myRefCode ? '&ref=' + encodeURIComponent(window.__myRefCode) : '');
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise(function (resolve, reject) {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;opacity:0;';
                document.body.appendChild(ta);
                ta.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(ta);
                ok ? resolve() : reject(new Error('copy failed'));
            } catch (e) { reject(e); }
        });
    }

    function shareTable() {
        var code = currentCode();
        if (!code) { toast('Join or create a table first.'); return; }
        var url = inviteUrl(code);
        var data = { title: 'Join my Blitz 31 table', text: 'Join my Blitz 31 table (code ' + code + ')', url: url };
        if (navigator.share) {
            navigator.share(data).catch(function (err) {
                if (err && err.name === 'AbortError') return;
                copyText(url).then(function () { toast('Invite link copied!'); }, function () { toast(url); });
            });
            return;
        }
        copyText(url).then(function () { toast('Invite link copied!'); }, function () { toast(url); });
    }
    window.shareTableInvite = shareTable;

    function ensureShareButton() {
        if (!gameVisible() || $('invite-share-btn')) return;
        var title = $('room-title-display');
        if (!title || !title.parentNode) return;
        var btn = document.createElement('button');
        btn.id = 'invite-share-btn';
        btn.className = 'tool-btn';
        btn.type = 'button';
        btn.textContent = '🔗 Invite';
        btn.title = 'Share a link to this table';
        btn.style.marginLeft = '8px';
        btn.onclick = shareTable;
        title.parentNode.insertBefore(btn, title.nextSibling);
    }

    // ---------------------------------------------------------
    // 5. GUEST REMINDER PILL
    // ---------------------------------------------------------
    function ensureGuestPill() {
        var pill = $('guest-pill');
        var show = isGuest() && (menuVisible() || gameVisible());
        if (!show) { if (pill) pill.style.display = 'none'; return; }
        if (!pill) {
            pill = document.createElement('div');
            pill.id = 'guest-pill';
            pill.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:9000;' +
                'display:flex;gap:8px;align-items:center;background:rgba(6,28,17,.95);color:#fde68a;' +
                'border:1px solid rgba(251,191,36,.6);border-radius:999px;padding:6px 8px 6px 14px;font-size:.8rem;' +
                'box-shadow:0 6px 18px rgba(0,0,0,.6);max-width:94vw;';
            var span = document.createElement('span');
            span.textContent = 'Playing as guest';
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = 'Create account';
            b.style.cssText = 'background:linear-gradient(135deg,#d97706,#b45309);color:#fff;border:1px solid #fbbf24;' +
                'border-radius:999px;padding:5px 12px;font-weight:700;font-size:.78rem;cursor:pointer;';
            b.onclick = function () {
                if (typeof window.logoutSession === 'function') window.logoutSession();
                setTimeout(function () {
                    if (typeof window.switchAuthTab === 'function') window.switchAuthTab('register');
                    else if (typeof switchAuthTab === 'function') switchAuthTab('register');
                }, 50);
            };
            pill.appendChild(span);
            pill.appendChild(b);
            document.body.appendChild(pill);
        }
        pill.style.display = 'flex';
    }

    setInterval(tick, 400);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
    else tick();
})();
