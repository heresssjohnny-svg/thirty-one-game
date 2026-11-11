// public/js/referral.js - invite friends, earn Premium.
//  - Remembers ?ref=CODE from an invite link (30 days) and adds it to the sign-up request
//  - "🎁 Invite" tab in the Premium panel + a small "Invite friends · earn Premium" button on the main menu:
//    your link, share/copy, how many joined, who has played, days earned (GET /api/referrals/me)
//  - Shows the REFERRAL_REWARD message when a friend's first match earns you Premium time
(function () {
    'use strict';
    if (window.__referralLoaded) return;
    window.__referralLoaded = true;

    var KEY = 'blitz31_ref';
    function token() { try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function note(m) { if (typeof window.showCenterNotification === 'function') window.showCenterNotification(m); }

    // 1. remember ?ref=CODE
    try {
        var params = new URLSearchParams(location.search), r = String(params.get('ref') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
        if (r) localStorage.setItem(KEY, JSON.stringify({ code: r, at: Date.now() }));
        if (params.has('ref')) { params.delete('ref'); var rest = params.toString(); history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); }
    } catch (e) {}
    function storedRef() {
        try { var o = JSON.parse(localStorage.getItem(KEY) || 'null'); if (o && o.code && Date.now() - o.at < 30 * 86400000) return o.code; } catch (e) {}
        return '';
    }
    // 2. add it to the sign-up request
    var ofetch = window.fetch;
    if (typeof ofetch === 'function') {
        window.fetch = function (url, opts) {
            try {
                var u = typeof url === 'string' ? url : (url && url.url) || '';
                if (/\/auth\/register$/.test(u) && opts && String(opts.method || '').toUpperCase() === 'POST' && typeof opts.body === 'string') {
                    var ref = storedRef();
                    if (ref) { var b = JSON.parse(opts.body); if (!b.ref) { b.ref = ref; opts = Object.assign({}, opts, { body: JSON.stringify(b) }); } }
                }
            } catch (e) {}
            return ofetch.call(this, url, opts);
        };
    }

    // 3. my referral info
    var data = null, loadedAt = 0, loading = false;
    function load(force, cb) {
        if (!token()) { data = null; return cb && cb(); }
        if (!force && data && Date.now() - loadedAt < 30000) return cb && cb();
        if (loading) return;
        loading = true;
        fetch('/api/referrals/me', { headers: { Authorization: 'Bearer ' + token() } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { loading = false; if (j) { data = j; loadedAt = Date.now(); window.__myRefCode = j.code; } cb && cb(); })
            .catch(function () { loading = false; cb && cb(); });
    }
    function link() { return data && data.code ? location.origin + '/?ref=' + encodeURIComponent(data.code) : ''; }
    function share() {
        var url = link(); if (!url) return;
        var text = 'Play Blitz 31 with me — the card game "31" online with friends. Sign up with my link:';
        if (navigator.share) { navigator.share({ title: 'Blitz 31', text: text, url: url }).catch(function () {}); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { note('🔗 Invite link copied'); });
        else window.prompt('Copy your invite link:', url);
    }
    window.shareReferralLink = share;

    var BTN = 'padding:8px 12px;border-radius:8px;border:1px solid rgba(251,191,36,0.6);background:#1e293b;color:#fde68a;font-weight:800;cursor:pointer;';
    function render(el) {
        if (!token() || (window.userSession && window.userSession.isGuest)) { el.innerHTML = '<div class="ph-note">Create an account to get your invite link.</div>'; return; }
        if (!data) { el.innerHTML = '<div class="ph-note">Loading…</div>'; load(true, function () { render(el); }); return; }
        var d = data, until = d.premiumUntil ? new Date(d.premiumUntil).toLocaleDateString() : null;
        var html = '<div class="ph-h">🎁 Invite friends, earn Premium</div>' +
            '<div style="color:#cbd5e1;font-size:0.82rem;line-height:1.4;">For every new player who signs up with your link and finishes their first match, you get <b style="color:#fde68a">+' + d.rewardDays + ' days of Premium</b>. Time stacks.</div>' +
            '<div style="display:flex;gap:6px;margin-top:10px;"><input readonly value="' + esc(link()) + '" style="flex:1;min-width:0;padding:8px;border-radius:8px;border:1px solid rgba(251,191,36,0.5);background:#0f172a;color:#f8fafc;font-size:0.78rem;">' +
            '<button type="button" data-ref-share style="' + BTN + 'background:#065f46;color:#fff;border-color:#6ee7b7;">Share</button></div>' +
            '<div class="ps-grid" style="grid-template-columns:repeat(3,1fr);margin-top:10px;">' +
            '<div class="ps-tile"><b>' + d.joined + '</b><span>joined</span></div>' +
            '<div class="ps-tile"><b>' + d.rewarded + '</b><span>played</span></div>' +
            '<div class="ps-tile"><b>' + d.daysEarned + '</b><span>days earned</span></div></div>' +
            (until ? '<div class="ph-note" style="color:#c4b5fd">💎 Earned Premium active until ' + esc(until) + '</div>' : '');
        html += '<div class="ph-h">Your invites</div>';
        if (!d.invited.length) html += '<div class="ph-note">Nobody yet — share your link! Table invite links count too.</div>';
        else html += d.invited.map(function (x) {
            var st = x.status === 'rewarded' ? '<span style="color:#34d399">✓ +' + d.rewardDays + ' days</span>' : x.status === 'played' ? '<span style="color:#fde68a">reward on its way</span>' :
                x.status === 'capped' ? '<span style="color:#94a3b8">counted (monthly limit)</span>' : '<span style="color:#94a3b8">waiting for first match</span>';
            return '<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 8px;margin-bottom:4px;border-radius:8px;background:#1e293b;font-size:0.8rem;color:#e2e8f0;"><b>' + esc(x.name) + '</b>' + st + '</div>';
        }).join('');
        html += '<div class="ph-note">Up to ' + d.maxPer30d + ' rewards every 30 days.</div>';
        el.innerHTML = html;
        if (!el.__refBound) { el.__refBound = true; el.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('[data-ref-share]')) share(); }); }
    }
    var tries = 0, t = setInterval(function () {
        if (typeof window.__phAddTab === 'function') { window.__phAddTab('invite', '🎁 Invite', function (el) { load(false, function () { render(el); }); render(el); }, 5); clearInterval(t); }
        else if (++tries > 100) clearInterval(t);
    }, 200);

    // 4. small main-menu button (below the Friends card)
    function ensureMenuButton() {
        var menu = document.getElementById('main-menu');
        var signedIn = !!token() && !(window.userSession && window.userSession.isGuest);
        var b = document.getElementById('ref-menu-btn');
        if (!menu || !signedIn) { if (b) b.remove(); return; }
        if (b) return;
        b = document.createElement('button');
        b.type = 'button'; b.id = 'ref-menu-btn';
        b.style.cssText = 'display:block;width:100%;max-width:420px;margin:10px auto;padding:10px 12px;border-radius:12px;border:1px solid #a78bfa;background:linear-gradient(180deg,#5b21b6,#3b0764);color:#fff;font-weight:800;font-size:0.9rem;cursor:pointer;';
        b.textContent = '🎁 Invite friends · earn free Premium';
        b.onclick = function () { if (typeof window.openPremiumHub === 'function') window.openPremiumHub('invite'); };
        var friends = document.getElementById('friends-card');
        if (friends && friends.parentNode) friends.parentNode.insertBefore(b, friends.nextSibling); else menu.appendChild(b);
    }
    setInterval(function () { ensureMenuButton(); if (token() && !window.__myRefCode) load(false); }, 1500);

    // 5. reward message
    var hooked = null;
    setInterval(function () {
        var ws = window.appGlobals && window.appGlobals.ws;
        if (!ws || ws === hooked) return;
        hooked = ws;
        ws.addEventListener('message', function (ev) {
            var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
            if (d && d.type === 'REFERRAL_REWARD' && d.message) {
                note(d.message); load(true);
                if (typeof window.__premiumRefresh === 'function') try { window.__premiumRefresh(); } catch (e) {}
            }
        });
    }, 500);
})();
