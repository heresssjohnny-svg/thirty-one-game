// public/js/friendCompare.js - 📊 next to each friend opens a side-by-side comparison (GET /api/friends/compare).
// Basic match stats for everyone; deep round stats + head-to-head for Premium viewers (locked teaser otherwise).
(function () {
    'use strict';
    if (window.__friendCompareLoaded) return;
    window.__friendCompareLoaded = true;

    function token() { try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    var modal = null;
    function ensure() {
        if (modal && document.body.contains(modal)) return modal;
        modal = document.createElement('div');
        modal.id = 'fc-modal';
        modal.innerHTML = '<div id="fc-sheet" role="dialog" aria-label="Compare stats"><div id="fc-head"><b id="fc-title">Compare</b><button type="button" id="fc-close" aria-label="Close">✕</button></div><div id="fc-body"></div></div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', function (ev) {
            if (ev.target === modal || (ev.target.closest && ev.target.closest('#fc-close'))) modal.classList.remove('open');
            if (ev.target.closest && ev.target.closest('[data-fc-premium]')) { modal.classList.remove('open'); if (typeof window.openPremiumHub === 'function') window.openPremiumHub('stats'); }
        });
        return modal;
    }
    // row: label, my value, their value, higherIsBetter (null = no highlight)
    function row(label, a, b, better, suffix) {
        suffix = suffix || '';
        var na = Number(a) || 0, nb = Number(b) || 0, ca = '', cb = '';
        if (better != null && na !== nb) { var aWins = better ? na > nb : na < nb; ca = aWins ? ' win' : ''; cb = aWins ? '' : ' win'; }
        return '<div class="fc-row"><span class="fc-v' + ca + '">' + esc(a) + suffix + '</span><span class="fc-l">' + esc(label) + '</span><span class="fc-v' + cb + '">' + esc(b) + suffix + '</span></div>';
    }
    function paint(d) {
        var b = modal.querySelector('#fc-body');
        var me = d.me, th = d.them, A = me.basic || {}, B = th.basic || {};
        var html = '<div class="fc-names"><span>' + esc(me.name) + '</span><span>vs</span><span>' + esc(th.name) + '</span></div>';
        if (d.h2h && d.h2h.matches) {
            html += '<div class="fc-h2h">Head-to-head: <b>' + d.h2h.aWins + '</b> – <b>' + d.h2h.bWins + '</b> in ' + d.h2h.matches + ' match' + (d.h2h.matches === 1 ? '' : 'es') +
                (d.h2h.rounds ? '<br><small>Lives lost together: you ' + d.h2h.aLost + ' · them ' + d.h2h.bLost + ' (' + d.h2h.rounds + ' rounds)</small>' : '') + '</div>';
        }
        html += '<div class="fc-sec">Matches</div>' +
            row('wins', A.wins, B.wins, true) + row('played', A.games, B.games, null) + row('win rate', A.winRate, B.winRate, true, '%') +
            row('wins vs people', A.humanWins, B.humanWins, true) + row('win streak', A.winStreak, B.winStreak, true) +
            row('best streak', A.bestWinStreak, B.bestWinStreak, true) + row('day streak', A.dayStreak, B.dayStreak, true);
        if (me.deep && th.deep) {
            var X = me.deep, Y = th.deep;
            html += '<div class="fc-sec">Rounds 💎</div>' +
                row('rounds', X.rounds, Y.rounds, null) + row('avg score', X.avgScore, Y.avgScore, true) + row('best', X.best, Y.best, true) +
                row('hit 31', X.hit31, Y.hit31, true) + row('knocks', X.knocks, Y.knocks, null) + row('safe knocks', X.knockRate, Y.knockRate, true, '%') +
                row('kept lives', X.survived, Y.survived, true, '%');
            if (!d.h2h || !d.h2h.matches) html += '<div class="fc-note">No matches together yet — play each other to start a head-to-head record.</div>';
        } else {
            html += '<button type="button" class="fc-lock" data-fc-premium>🔒 Premium adds round stats (avg score, 31s, safe knocks, kept lives) and your head-to-head record.</button>';
        }
        b.innerHTML = html;
    }
    window.openFriendCompare = function (name) {
        ensure();
        modal.querySelector('#fc-title').textContent = '📊 You vs ' + name;
        modal.querySelector('#fc-body').innerHTML = '<div class="fc-note">Loading…</div>';
        modal.classList.add('open');
        fetch('/api/friends/compare?username=' + encodeURIComponent(name), { headers: { Authorization: 'Bearer ' + token() } })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (x) {
                if (!x.ok) { modal.querySelector('#fc-body').innerHTML = '<div class="fc-note">' + esc((x.j && x.j.error) || 'Could not load stats.') + '</div>'; return; }
                paint(x.j);
            })
            .catch(function () { modal.querySelector('#fc-body').innerHTML = '<div class="fc-note">Could not load stats. Check your connection.</div>'; });
    };
})();
