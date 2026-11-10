// public/js/premiumStats.js - Premium practical extras:
//   📊 Stats tab: deep-dive stats, head-to-head vs friends, recent round recaps (hand history)
//   Table tab (host only): rename the table + pick a theme everyone at the table sees (SET_TABLE_STYLE)
(function () {
    'use strict';
    if (window.__premiumStatsLoaded) return;
    window.__premiumStatsLoaded = true;

    function prem() { return !!window.__isPremium; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function token() { try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; } }
    function snap() { return window.appGlobals && window.appGlobals.latestLobbySnapshot; }
    function atTable() { var gv = document.getElementById('game-view'); var s = snap(); return !!(s && s.code && gv && gv.offsetParent !== null); }

    // ---------- host table theme (read by premium.js applyStyle) ----------
    window.__tableThemeNow = function () { var s = snap(); return (atTable() && s && s.tableTheme) ? s.tableTheme : null; };
    var lastTT = null;
    setInterval(function () {
        var t = window.__tableThemeNow();
        if (t !== lastTT) { lastTT = t; if (window.__pfApi) window.__pfApi.apply(); }
    }, 700);

    // ---------- Stats tab ----------
    var cache = { at: 0, deep: null, hist: null, err: null };
    function load(force, done) {
        if (!force && Date.now() - cache.at < 30000 && (cache.deep || cache.err)) return done();
        var h = { headers: { Authorization: 'Bearer ' + token() } };
        Promise.all([fetch('/api/stats/deep', h), fetch('/api/history', h)]).then(function (rs) {
            if (!rs[0].ok) throw new Error(rs[0].status === 403 ? 'premium' : 'fail');
            return Promise.all([rs[0].json(), rs[1].json()]);
        }).then(function (d) { cache = { at: Date.now(), deep: d[0], hist: d[1], err: null }; done(); })
          .catch(function (e) { cache = { at: Date.now(), deep: null, hist: null, err: e.message }; done(); });
    }
    function tile(v, label) { return '<div class="ps-tile"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>'; }
    function mini(c) {
        var red = c.suit === '♥' || c.suit === '♦';
        return '<span class="ps-card' + (red ? ' r' : '') + '" data-suit="' + esc(c.suit) + '">' + esc(c.val) + esc(c.suit) + '</span>';
    }
    function ago(t) {
        var m = Math.round((Date.now() - t) / 60000);
        if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
        var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
        return Math.round(h / 24) + ' d ago';
    }
    function renderStats(el) {
        if (!prem()) {
            el.innerHTML = '<div class="ph-h">📊 Stats deep-dive</div><div class="ps-lock">🔒 Premium shows your average score, how often you hit 31, knock success, head-to-head records against friends, and a recap of your last 15 rounds.</div>';
            return;
        }
        if (!cache.deep && !cache.err) el.innerHTML = '<div class="ph-note">Loading…</div>';
        load(false, function () { paint(el); });
        if (cache.deep || cache.err) paint(el);
    }
    function paint(el) {
        if (cache.err) { el.innerHTML = '<div class="ph-note">Stats could not load right now. Try again in a moment.</div>'; return; }
        var d = cache.deep || {}, hist = (cache.hist && cache.hist.rounds) || [];
        var html = '<div class="ph-h">Your rounds</div><div class="ps-grid">' +
            tile(d.rounds, 'rounds') + tile(d.avgScore, 'avg score') + tile(d.best, 'best') + tile(d.hit31, 'hit 31') +
            tile(d.knocks, 'knocks') + tile(d.knockRate + '%', 'safe knocks') + tile(d.survived + '%', 'kept lives') + tile(d.livesLost, 'lives lost') +
            '</div><div class="ph-h">Matches</div><div class="ps-grid">' + tile(d.matches, 'vs people') + tile(d.wins, 'won') + tile(d.winRate + '%', 'win rate') + '</div>';
        html += '<div class="ph-h">Head-to-head</div>';
        if (!d.h2h || !d.h2h.length) html += '<div class="ph-note">Play a few rounds with other real players to see this.</div>';
        else html += '<div class="ps-h2h">' + d.h2h.map(function (h) {
            return '<div class="ps-row"><b>' + esc(h.name) + '</b><span>Matches ' + h.myWins + '–' + h.theirWins + ' of ' + h.matches + '</span><span>Lives lost: you ' + h.myLost + ' · them ' + h.theirLost + ' (' + h.rounds + ' rounds)</span></div>';
        }).join('') + '</div>';
        html += '<div class="ph-h">Recent rounds</div>';
        if (!hist.length) html += '<div class="ph-note">No rounds recorded yet. Rounds are saved from now on.</div>';
        else html += hist.map(function (r) {
            return '<div class="ps-round"><div class="ps-rh">' + esc(r.table || 'Table') + ' · ' + ago(r.at) + '</div>' + r.players.map(function (p) {
                var tags = (p.hit31 ? ' ⚡31' : '') + (p.knocked ? ' ✊knock' : '') + (p.out ? ' 💀out' : (p.lostLife ? ' 💔' : ''));
                return '<div class="ps-pl' + (p.me ? ' me' : '') + '"><span class="ps-n">' + esc(p.name) + (p.me ? ' (you)' : '') + '</span><span class="ps-cs">' +
                    (p.cards || []).slice(0, 3).map(mini).join('') + '</span><span class="ps-sc">' + esc(p.score) + '</span><span class="ps-tg">' + tags + '</span></div>';
            }).join('') + '</div>';
        }).join('');
        html += '<button type="button" data-ps-reload class="ps-btn">↻ Refresh</button>';
        el.innerHTML = html;
        if (!el.__psBound) { el.__psBound = true; el.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('[data-ps-reload]')) load(true, function () { paint(el); }); }); }
    }

    // ---------- host: this table ----------
    function iAmHost() {
        var s = snap(); if (!s || !atTable()) return false;
        if (typeof window.isCurrentUserLobbyHost === 'function') { try { return !!window.isCurrentUserLobbyHost(s); } catch (e) {} }
        return false;
    }
    window.__phTableExtra = function (el) {
        if (!el) return;
        if (!iAmHost()) { el.innerHTML = ''; return; }
        var s = snap(), a = window.__pfApi;
        if (!prem()) { el.innerHTML = '<div class="ph-h">🏷️ This table (host)</div><div class="ps-lock">🔒 Premium hosts can rename the table and pick a theme everyone at the table sees.</div>'; return; }
        var cur = s.tableTheme || '';
        el.innerHTML = '<div class="ph-h">🏷️ This table (you host it)</div>' +
            '<div style="display:flex;gap:6px;"><input data-ts-name maxlength="24" value="' + esc(s.name || '') + '" style="flex:1;min-width:0;padding:7px;border-radius:8px;border:1px solid rgba(251,191,36,0.5);background:#0f172a;color:#f8fafc;">' +
            '<button type="button" data-ts-save class="ps-btn" style="margin:0">Rename</button></div>' +
            '<div class="ph-note" style="margin-bottom:4px">Table theme for everyone here:</div><div class="ph-grid">' +
            '<button type="button" class="ph-tile' + (!cur ? ' on' : '') + '" data-ts-theme=""><span class="ph-ico">👤</span>Each player\'s own</button>' +
            (a ? a.THEMES : []).map(function (t) {
                return '<button type="button" class="ph-tile' + (cur === t.id ? ' on' : '') + '" data-ts-theme="' + t.id + '"><span class="ph-ico">' + t.icon + '</span>' + esc(t.name) + '</button>';
            }).join('') + '</div>';
        if (!el.__tsBound) {
            el.__tsBound = true;
            el.addEventListener('click', function (ev) {
                var sv = ev.target.closest && ev.target.closest('[data-ts-save]');
                if (sv) { var inp = el.querySelector('[data-ts-name]'); if (inp && inp.value.trim()) window.sendSocket({ type: 'SET_TABLE_STYLE', name: inp.value.trim() }); if (typeof window.showCenterNotification === 'function') window.showCenterNotification('🏷️ Table renamed'); return; }
                var th = ev.target.closest && ev.target.closest('[data-ts-theme]');
                if (th) {
                    window.sendSocket({ type: 'SET_TABLE_STYLE', theme: th.getAttribute('data-ts-theme') || null });
                    [].forEach.call(el.querySelectorAll('[data-ts-theme]'), function (b) { b.classList.toggle('on', b === th); });
                }
            });
        }
    };

    function addTab() {
        if (typeof window.__phAddTab !== 'function') return false;
        window.__phAddTab('stats', '📊 Stats', renderStats, 50);
        return true;
    }
    var tries = 0, t = setInterval(function () { if (addTab() || ++tries > 100) clearInterval(t); }, 200);
})();
