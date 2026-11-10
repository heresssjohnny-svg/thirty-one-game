// public/js/premiumHub.js - one "💎 Premium & Style" button in Settings that opens a tabbed panel,
// so the main Settings list stays short. Tabs: Table (themes, felt, card back) · Cards (face styles)
// · Celebrate (celebration sounds) · more tabs can be added by other modules via window.__phAddTab.
// Locked (🔒) options are shown to free users so they can see what Premium includes.
(function () {
    'use strict';
    if (window.__premiumHubLoaded) return;
    window.__premiumHubLoaded = true;

    var tabs = [];          // {id, label, render(el), order}
    var current = 'table';
    var panel = null, body = null, tabBar = null;

    function api() { return window.__pfApi; }
    function prem() { return !!window.__isPremium; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function locked() { if (typeof window.showCenterNotification === 'function') window.showCenterNotification('🔒 Premium option'); }

    window.__phAddTab = function (id, label, render, order) {
        tabs = tabs.filter(function (t) { return t.id !== id; });
        tabs.push({ id: id, label: label, render: render, order: order == null ? 50 : order });
        tabs.sort(function (a, b) { return a.order - b.order; });
        if (panel) buildTabs();
    };

    // ---------- built-in tabs ----------
    function renderTable(el) {
        var a = api(); if (!a) return;
        var cur = { felt: a.get('blitz31_felt'), back: a.get('blitz31_back'), face: a.get('blitz31_face') };
        var html = '<div data-ph-slot="host"></div><div class="ph-h">Table themes</div><div class="ph-grid">' + a.THEMES.map(function (t) {
            var on = cur.felt === t.felt && cur.back === t.back && cur.face === t.face;
            var lk = !t.free && !prem();
            return '<button type="button" class="ph-tile' + (on ? ' on' : '') + (lk ? ' locked' : '') + '" data-theme="' + t.id + '">' +
                (lk ? '<span class="ph-lk">🔒</span>' : '') + '<span class="ph-ico">' + t.icon + '</span>' + esc(t.name) + '</button>';
        }).join('') + '</div><div class="ph-note">A theme sets the felt, card back and card faces at once. You can still change each one below.</div>' +
            '<div class="ph-h">Felt &amp; card back</div><div data-ph-slot="style"></div>';
        el.innerHTML = html;
        var sec = document.getElementById('pf-style-section');
        if (sec) el.querySelector('[data-ph-slot="style"]').appendChild(sec);
        if (typeof window.__phTableExtra === 'function') { try { window.__phTableExtra(el.querySelector('[data-ph-slot="host"]')); } catch (e) {} }
    }
    function renderCards(el) {
        var a = api(); if (!a) return;
        var cur = a.get('blitz31_face');
        var demo = {
            classic: '<span style="color:#0f172a">A♠</span><span style="color:#dc2626">K♦</span>',
            big: '<span style="color:#0f172a;font-size:0.95rem;font-weight:900">A♠</span><span style="color:#dc2626;font-size:0.95rem;font-weight:900">K♦</span>',
            four: '<span style="color:#0f172a">A♠</span><span style="color:#2563eb">K♦</span><span style="color:#15803d">9♣</span>',
            retro: '<span style="color:#0f172a;background:#f6efdc;font-family:Georgia,serif">A♠</span><span style="color:#dc2626;background:#f6efdc;font-family:Georgia,serif">K♦</span>'
        };
        el.innerHTML = '<div class="ph-h">Card faces</div><div class="ph-grid">' + a.FACES.map(function (f) {
            var lk = !f.free && !prem();
            return '<button type="button" class="ph-tile' + (cur === f.id ? ' on' : '') + (lk ? ' locked' : '') + '" data-face="' + f.id + '">' +
                (lk ? '<span class="ph-lk">🔒</span>' : '') + '<span class="ph-face-demo">' + (demo[f.id] || '') + '</span><br>' + esc(f.name) + '</button>';
        }).join('') + '</div><div class="ph-note">Big index is easier to read on a phone. Four-colour makes ♦ blue and ♣ green so suits are never mixed up. Card faces only change on your own screen.</div>';
    }
    function renderCelebrate(el) {
        el.innerHTML = '<div data-ph-slot="cel"></div>';
        var sec = document.getElementById('cs-section');
        if (sec) el.firstChild.appendChild(sec);
    }

    window.__phAddTab('table', '🎨 Table', renderTable, 10);
    window.__phAddTab('cards', '🃏 Cards', renderCards, 20);
    window.__phAddTab('celebrate', '🎉 Celebrate', renderCelebrate, 40);

    // ---------- panel ----------
    function ensurePanel() {
        if (panel && document.body.contains(panel)) return;
        panel = document.createElement('div');
        panel.id = 'ph-panel';
        panel.innerHTML = '<div id="ph-sheet" role="dialog" aria-label="Premium and style">' +
            '<div id="ph-head"><b>💎 Premium &amp; Style</b><button type="button" id="ph-close" aria-label="Close">✕</button></div>' +
            '<div id="ph-tabs"></div><div id="ph-body"></div></div>';
        document.body.appendChild(panel);
        body = panel.querySelector('#ph-body'); tabBar = panel.querySelector('#ph-tabs');
        panel.addEventListener('click', function (ev) {
            if (ev.target === panel || (ev.target.closest && ev.target.closest('#ph-close'))) { close(); return; }
            var tb = ev.target.closest && ev.target.closest('#ph-tabs button');
            if (tb) { show(tb.getAttribute('data-tab')); return; }
            var a = api(); if (!a) return;
            var th = ev.target.closest && ev.target.closest('[data-theme]');
            if (th) { if (!a.applyTheme(th.getAttribute('data-theme'))) locked(); refreshTab(); return; }
            var fc = ev.target.closest && ev.target.closest('[data-face]');
            if (fc) {
                var f = a.FACES.filter(function (x) { return x.id === fc.getAttribute('data-face'); })[0];
                if (f && !f.free && !prem()) { locked(); return; }
                a.set('blitz31_face', fc.getAttribute('data-face')); refreshTab();
            }
        });
        buildTabs();
    }
    function buildTabs() {
        if (!tabBar) return;
        tabBar.innerHTML = tabs.map(function (t) { return '<button type="button" data-tab="' + t.id + '">' + esc(t.label) + '</button>'; }).join('');
        body.innerHTML = tabs.map(function (t) { return '<div class="ph-tab" data-pane="' + t.id + '"></div>'; }).join('');
        show(current);
    }
    function pane(id) { return body && body.querySelector('[data-pane="' + id + '"]'); }
    function refreshTab() { var t = tabs.filter(function (x) { return x.id === current; })[0], p = pane(current); if (t && p) t.render(p); }
    function show(id) {
        if (!tabs.some(function (t) { return t.id === id; })) id = tabs[0] && tabs[0].id;
        current = id;
        [].forEach.call(tabBar.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === id); });
        [].forEach.call(body.querySelectorAll('.ph-tab'), function (p) { p.classList.toggle('on', p.getAttribute('data-pane') === id); });
        refreshTab();
    }
    function open(tab) {
        ensurePanel();
        if (typeof window.__premiumRefresh === 'function') { try { window.__premiumRefresh(); } catch (e) {} }
        panel.classList.add('open');
        show(tab || current);
    }
    function close() {
        if (!panel) return;
        panel.classList.remove('open');
        // park the moved sections back in Settings (hidden there by CSS) so their owners keep them alive
        var content = document.querySelector('#settings-modal .settings-content');
        ['pf-style-section', 'cs-section'].forEach(function (id) { var s = document.getElementById(id); if (s && content) content.appendChild(s); });
    }
    window.openPremiumHub = open;
    window.__phRefresh = function () { if (panel && panel.classList.contains('open')) refreshTab(); };
    window.closePremiumHub = close;

    // ---------- Settings entry button ----------
    function ensureEntry() {
        var content = document.querySelector('#settings-modal .settings-content');
        if (!content) return;
        var row = document.getElementById('ph-open-row');
        if (!row) {
            row = document.createElement('div');
            row.id = 'ph-open-row';
            row.innerHTML = '<button type="button" id="ph-open"><span>💎 Premium &amp; Style</span><small></small></button>';
            content.appendChild(row);
            row.querySelector('#ph-open').addEventListener('click', function () { open(); });
        } else if (row.nextSibling && row.parentNode === content) {
            content.appendChild(row);   // keep it last
        }
        var sm = row.querySelector('small'), txt = window.__isAdminAccount ? 'Admin · all unlocked' : (prem() ? 'Unlocked' : 'Themes, cards, sounds ›');
        if (sm.textContent !== txt) sm.textContent = txt;
    }

    // ---------- tag card suits (for four-colour faces) ----------
    var pending = false;
    function tagSuits() {
        pending = false;
        if (document.body.getAttribute('data-pf-face') !== 'four') return;
        [].forEach.call(document.querySelectorAll('.playing-card:not(.back), .mini-card:not(.back)'), function (c) {
            var s = '';
            var cs = c.querySelector('.corner-suit');
            if (cs) s = cs.textContent.trim();
            else { var m = (c.textContent || '').match(/[♠♥♦♣]/); s = m ? m[0] : ''; }
            if (s && c.getAttribute('data-suit') !== s) c.setAttribute('data-suit', s);
        });
    }
    try {
        new MutationObserver(function () { if (!pending) { pending = true; requestAnimationFrame(tagSuits); } })
            .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pf-face'] });
    } catch (e) {}

    setInterval(ensureEntry, 1000);
})();
