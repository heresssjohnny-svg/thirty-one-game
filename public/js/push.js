// public/js/push.js - "Notifications" switch in Settings (web push).
//
// Tells you when a rematch is ready or it is your turn while the app is closed. Needs a logged-in account
// (not a guest), a browser with push support and the server's VAPID keys (/api/push/key says enabled:true).
// On iPhone push only works for the installed app (Share -> Add to Home Screen); the row says so.
(function () {
    'use strict';
    if (window.__pushLoaded) return;
    window.__pushLoaded = true;

    function token() {
        try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; }
    }
    function isGuestToken(t) {
        try {
            var p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return !!(p && (p.guest || p.isGuest));
        } catch (e) { return false; }
    }
    function standalone() {
        try {
            return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
        } catch (e) { return false; }
    }
    var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var supported = ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);

    function b64ToBytes(b64) {
        var pad = '='.repeat((4 - (b64.length % 4)) % 4);
        var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }
    function post(path, body) {
        return fetch(path, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) { return r.ok; }).catch(function () { return false; });
    }

    var row = null, box = null, hint = null, publicKey = null;

    function ensureRow() {
        if (row) return true;
        var anchor = document.getElementById('setting-audio-output');
        var anchorRow = anchor && anchor.parentNode;
        if (!anchorRow || !anchorRow.parentNode) return false;
        row = document.createElement('div');
        row.className = 'setting-row';
        row.id = 'push-setting-row';
        row.style.cssText = 'display:none;justify-content:space-between;align-items:center;margin-bottom:12px;';
        var span = document.createElement('span');
        span.textContent = 'Notifications ';
        hint = document.createElement('small');
        hint.style.cssText = 'display:block;font-size:0.7rem;color:#94a3b8;';
        span.appendChild(hint);
        var label = document.createElement('label');
        label.className = 'switch-toggle';
        box = document.createElement('input');
        box.type = 'checkbox';
        box.id = 'setting-push';
        var slider = document.createElement('span');
        slider.className = 'toggle-slider';
        label.appendChild(box);
        label.appendChild(slider);
        row.appendChild(span);
        row.appendChild(label);
        anchorRow.parentNode.insertBefore(row, anchorRow);
        box.addEventListener('change', onToggle);
        return true;
    }

    function setHint(t) { if (hint) hint.textContent = t; }

    function registration() {
        return navigator.serviceWorker.getRegistration('/').then(function (r) {
            return r || navigator.serviceWorker.ready;
        });
    }

    function onToggle() {
        if (!publicKey) { box.checked = false; return; }
        if (box.checked) {
            box.disabled = true;
            setHint('Turning on...');
            Notification.requestPermission().then(function (perm) {
                if (perm !== 'granted') throw new Error('denied');
                return registration();
            }).then(function (reg) {
                return reg.pushManager.getSubscription().then(function (s) {
                    return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
                });
            }).then(function (sub) {
                var j = sub.toJSON();
                return post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
            }).then(function (ok) {
                if (!ok) throw new Error('server');
                setHint('Rematches and your turn when the app is closed');
            }).catch(function (e) {
                box.checked = false;
                setHint(e && e.message === 'denied' ? 'Blocked - allow notifications for this site in your phone settings' : 'Could not turn on. Try again.');
            }).then(function () { box.disabled = false; });
        } else {
            registration().then(function (reg) {
                return reg.pushManager.getSubscription();
            }).then(function (sub) {
                if (!sub) return;
                var ep = sub.endpoint;
                return sub.unsubscribe().then(function () { return post('/api/push/unsubscribe', { endpoint: ep }); });
            }).catch(function () {}).then(function () { setHint('Off'); });
        }
    }

    function refresh() {
        if (!supported || !ensureRow()) return;
        var t = token();
        if (!t || isGuestToken(t)) { row.style.display = 'none'; return; }
        fetch('/api/push/key', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (k) {
            if (!k || !k.enabled || !k.publicKey) { row.style.display = 'none'; return; }
            publicKey = k.publicKey;
            row.style.display = 'flex';
            if (isIos && !standalone()) {
                box.checked = false; box.disabled = true;
                setHint('On iPhone: Share, then Add to Home Screen, then open the app from there');
                return;
            }
            box.disabled = false;
            return registration().then(function (reg) {
                return reg.pushManager.getSubscription();
            }).then(function (sub) {
                var on = !!sub && Notification.permission === 'granted';
                box.checked = on;
                setHint(on ? 'Rematches and your turn when the app is closed' : 'Off');
                if (on) { var j = sub.toJSON(); post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys }); }
            });
        }).catch(function () { if (row) row.style.display = 'none'; });
    }

    var orig = window.openSettingsModal;
    if (typeof orig === 'function') {
        window.openSettingsModal = function () {
            var r = orig.apply(this, arguments);
            try { refresh(); } catch (e) {}
            return r;
        };
    }
    window.addEventListener('load', function () { setTimeout(refresh, 1500); });
    window.__pushRefresh = refresh;   // tests
})();
