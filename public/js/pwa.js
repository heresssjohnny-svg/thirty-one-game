// public/js/pwa.js - "install to home screen": service worker registration and an Install button.
// Loaded last. Android/desktop Chrome: uses the browser's install prompt. iPhone/iPad: shows a short
// "Share -> Add to Home Screen" guide (iOS has no install prompt API). Hidden once running installed.
(function () {
    'use strict';
    if (window.__pwaLoaded) return;
    window.__pwaLoaded = true;

    function $(id) { return document.getElementById(id); }

    function isStandalone() {
        try {
            return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                window.navigator.standalone === true;
        } catch (e) { return false; }
    }
    var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // ---------------------------------------------------------
    // 1. SERVICE WORKER
    // ---------------------------------------------------------
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function () {});
        });
    }

    // ---------------------------------------------------------
    // 2. INSTALL BUTTONS (main menu header + login card)
    // ---------------------------------------------------------
    var deferredPrompt = null;
    var buttons = [];

    function makeButton(id, cls, label, style) {
        var b = document.createElement('button');
        b.type = 'button';
        b.id = id;
        b.className = cls;
        b.textContent = label;
        b.style.display = 'none';
        if (style) b.style.cssText += style;
        b.addEventListener('click', onInstallClick);
        buttons.push(b);
        return b;
    }

    var headerActions = document.querySelector('.header-actions');
    if (headerActions) {
        headerActions.insertBefore(makeButton('install-app-btn', 'icon-btn gold-border', '📲 Install'), headerActions.firstChild);
    }
    var authCard = document.querySelector('.auth-card');
    if (authCard) {
        authCard.appendChild(makeButton('install-app-link', 'secondary-btn', '📲 Install the app',
            ';width:100%;margin-top:12px;'));
    }

    function refresh() {
        var show = !isStandalone() && (!!deferredPrompt || isIos);
        buttons.forEach(function (b) { b.style.display = show ? '' : 'none'; });
    }

    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredPrompt = e;
        refresh();
    });
    window.addEventListener('appinstalled', function () {
        deferredPrompt = null;
        refresh();
    });

    function onInstallClick() {
        if (deferredPrompt) {
            var p = deferredPrompt;
            deferredPrompt = null; // a prompt can only be used once
            refresh();
            try {
                p.prompt();
                if (p.userChoice && p.userChoice.then) p.userChoice.then(function () {}, function () {});
            } catch (e) {}
            return;
        }
        if (isIos) showIosGuide();
    }

    function showIosGuide() {
        var o = $('ios-install-guide');
        if (!o) {
            o = document.createElement('div');
            o.id = 'ios-install-guide';
            o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:100000;display:flex;' +
                'align-items:flex-end;justify-content:center;padding:16px;';
            o.innerHTML =
                '<div style="background:#071e13;border:1.5px solid #fbbf24;border-radius:12px;max-width:380px;width:100%;' +
                'padding:16px 18px;color:#e2e8f0;font-size:.95rem;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.7);">' +
                '<div style="color:#fbbf24;font-weight:800;font-size:1.05rem;margin-bottom:8px;">Add Blitz 31 to your Home Screen</div>' +
                '<ol style="margin:0 0 12px;padding-left:20px;">' +
                '<li>Tap the <b>Share</b> button (the square with an arrow) in Safari.</li>' +
                '<li>Scroll and tap <b>Add to Home Screen</b>.</li>' +
                '<li>Tap <b>Add</b>.</li></ol>' +
                '<div style="color:#94a3b8;font-size:.8rem;margin-bottom:12px;">Tip: this only works in Safari. If you opened the link inside another app, open it in Safari first.</div>' +
                '<button type="button" class="primary-btn gold-btn" style="width:100%" id="ios-install-close">Got it</button></div>';
            document.body.appendChild(o);
            o.addEventListener('click', function (ev) {
                if (ev.target === o || ev.target.id === 'ios-install-close') o.style.display = 'none';
            });
        }
        o.style.display = 'flex';
    }

    refresh();
    try {
        var mq = window.matchMedia('(display-mode: standalone)');
        if (mq.addEventListener) mq.addEventListener('change', refresh);
    } catch (e) {}
})();
