// public/js/adminLink.js - admin accounts get a "🛠 Admin" button (main menu header + Settings) that opens the
// admin panel in the same tab; admin.html signs them in with their game session (POST /auth/admin/sso).
(function () {
    'use strict';
    if (window.__adminLinkLoaded) return;
    window.__adminLinkLoaded = true;
    function go() { location.href = '/admin.html'; }
    function sync() {
        var on = !!window.__isAdminAccount;
        var hdr = document.querySelector('#main-menu .header-actions');
        var b = document.getElementById('admin-link-btn');
        if (on && hdr && !b) {
            b = document.createElement('button');
            b.id = 'admin-link-btn'; b.type = 'button'; b.className = 'icon-btn'; b.title = 'Admin panel'; b.textContent = '🛠 Admin';
            b.style.borderColor = '#a78bfa'; b.style.color = '#ddd6fe';
            b.onclick = go;
            hdr.insertBefore(b, hdr.firstChild);
        } else if (!on && b) b.remove();
        var content = document.querySelector('#settings-modal .settings-content');
        var r = document.getElementById('admin-link-row');
        if (on && content && !r) {
            r = document.createElement('div');
            r.id = 'admin-link-row';
            r.style.cssText = 'margin-top:10px;';
            r.innerHTML = '<button type="button" style="width:100%;padding:10px 12px;border-radius:10px;cursor:pointer;font-weight:800;font-size:.9rem;color:#fff;background:#1e293b;border:1px solid #a78bfa;">🛠 Admin Panel</button>';
            r.querySelector('button').onclick = go;
            content.appendChild(r);
        } else if (!on && r) r.remove();
    }
    setInterval(sync, 1000);
})();
