// public/js/stats.js - "Your stats" (wins, daily streak) and the leaderboard on the main menu.
// Loaded last. Reads /api/stats/me and /api/leaderboard; refreshes whenever the main menu comes into view.
(function () {
    'use strict';
    if (window.__statsLoaded) return;
    window.__statsLoaded = true;

    function $(id) { return document.getElementById(id); }
    function token() {
        try { return sessionStorage.getItem('31_jwt') || localStorage.getItem('31_jwt') || ''; } catch (e) { return ''; }
    }
    function api(path) {
        var t = token();
        return fetch(path, { headers: t ? { Authorization: 'Bearer ' + t } : {}, cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; });
    }
    function el(tag, css, text) {
        var n = document.createElement(tag);
        if (css) n.style.cssText = css;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    var main = document.querySelector('#main-menu .menu-content');
    if (!main) return;

    // ---------------------------------------------------------
    // 1. CARDS
    // ---------------------------------------------------------
    var statsCard = el('section');
    statsCard.id = 'stats-card';
    statsCard.className = 'menu-card casino-panel';
    statsCard.style.display = 'none';
    var statsTitle = el('h3'); statsTitle.className = 'gold-text'; statsTitle.textContent = 'Your Stats';
    var statsBody = el('div');
    statsCard.appendChild(statsTitle); statsCard.appendChild(statsBody);

    var boardCard = el('section');
    boardCard.id = 'leaderboard-card';
    boardCard.className = 'menu-card casino-panel';
    var head = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;');
    var boardTitle = el('h3'); boardTitle.className = 'gold-text'; boardTitle.style.margin = '0'; boardTitle.textContent = 'Leaderboard';
    var tabs = el('div', 'display:flex;gap:6px;');
    var period = 'week';
    var tabBtns = {};
    [['week', 'Week'], ['all', 'All-time']].forEach(function (p) {
        var b = el('button', 'padding:4px 10px;font-size:.75rem;', p[1]);
        b.type = 'button'; b.className = 'secondary-btn'; b.dataset.period = p[0];
        b.addEventListener('click', function () { period = p[0]; paintTabs(); loadBoard(); });
        tabBtns[p[0]] = b; tabs.appendChild(b);
    });
    head.appendChild(boardTitle); head.appendChild(tabs);
    var boardBody = el('div');
    boardCard.appendChild(head); boardCard.appendChild(boardBody);

    main.appendChild(statsCard);
    main.appendChild(boardCard);

    function paintTabs() {
        Object.keys(tabBtns).forEach(function (k) {
            var on = k === period;
            tabBtns[k].style.opacity = on ? '1' : '.55';
            tabBtns[k].style.outline = on ? '1.5px solid #fbbf24' : 'none';
        });
    }
    paintTabs();

    // ---------------------------------------------------------
    // 2. RENDER
    // ---------------------------------------------------------
    function tile(label, value) {
        var t = el('div', 'flex:1 1 30%;min-width:84px;background:rgba(0,0,0,.28);border:1px solid rgba(212,175,55,.3);' +
            'border-radius:8px;padding:8px 6px;text-align:center;');
        t.appendChild(el('div', 'font-size:1.25rem;font-weight:800;color:#fbbf24;', String(value)));
        t.appendChild(el('div', 'font-size:.68rem;color:#cbd5e1;text-transform:uppercase;letter-spacing:.04em;', label));
        return t;
    }

    function paintStats(s) {
        statsBody.textContent = '';
        if (!s) { statsCard.style.display = 'none'; return; }
        statsCard.style.display = '';
        if (s.guest) {
            statsBody.appendChild(el('p', 'margin:0;font-size:.85rem;color:#cbd5e1;',
                'You are playing as a guest. Create an account to track your wins and daily streak.'));
            return;
        }
        var row = el('div', 'display:flex;flex-wrap:wrap;gap:8px;');
        row.appendChild(tile('Wins', s.wins));
        row.appendChild(tile('Games', s.games));
        row.appendChild(tile('Win rate', s.winRate + '%'));
        row.appendChild(tile('Day streak', (s.dayStreak > 0 ? '🔥 ' : '') + s.dayStreak));
        row.appendChild(tile('Win streak', s.winStreak));
        row.appendChild(tile('Best streak', s.bestDayStreak + 'd'));
        statsBody.appendChild(row);
        if (s.streakAtRisk) {
            statsBody.appendChild(el('p', 'margin:8px 0 0;font-size:.82rem;color:#fbbf24;font-weight:700;',
                'Play a match today to keep your ' + s.dayStreak + '-day streak alive!'));
        } else if (!s.games) {
            statsBody.appendChild(el('p', 'margin:8px 0 0;font-size:.82rem;color:#94a3b8;', 'Finish a match to start your stats.'));
        }
    }

    function paintBoard(b) {
        boardBody.textContent = '';
        if (!b) { boardBody.appendChild(el('p', 'margin:0;font-size:.85rem;color:#94a3b8;', 'Leaderboard unavailable right now.')); return; }
        if (!b.top.length) {
            boardBody.appendChild(el('p', 'margin:0;font-size:.85rem;color:#94a3b8;',
                'No winners yet. Win a match against another player to get on the board.'));
            return;
        }
        b.top.forEach(function (r) {
            var line = el('div', 'display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;' +
                (r.me ? 'background:rgba(251,191,36,.16);border:1px solid rgba(251,191,36,.5);' : 'border:1px solid transparent;'));
            var medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : '#' + r.rank;
            line.appendChild(el('span', 'width:2.2em;text-align:center;font-weight:800;', medal));
            line.appendChild(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;color:#e2e8f0;', r.username));
            line.appendChild(el('span', 'font-weight:800;color:#fbbf24;', r.wins + (r.wins === 1 ? ' win' : ' wins')));
            boardBody.appendChild(line);
        });
        if (b.me && !b.top.some(function (r) { return r.me; })) {
            boardBody.appendChild(el('p', 'margin:8px 0 0;font-size:.82rem;color:#cbd5e1;', 'You are #' + b.me.rank + ' with ' + b.me.wins + ' wins.'));
        }
        boardBody.appendChild(el('p', 'margin:8px 0 0;font-size:.7rem;color:#64748b;',
            'Counts matches with at least two human players. Practice vs bots does not count.'));
    }

    // ---------------------------------------------------------
    // 3. LOADING (when the menu shows, then every minute while it stays open)
    // ---------------------------------------------------------
    function loadBoard() { api('/api/leaderboard?period=' + period).then(paintBoard); }
    function loadAll() {
        if (token()) api('/api/stats/me').then(paintStats); else paintStats(null);
        loadBoard();
    }

    function menuVisible() {
        var m = $('main-menu');
        return !!m && m.style.display !== 'none' && m.getClientRects().length > 0;
    }
    var wasVisible = false, lastLoad = 0;
    setInterval(function () {
        var v = menuVisible();
        var now = Date.now();
        if (v && (!wasVisible || now - lastLoad > 60000)) { lastLoad = now; loadAll(); }
        wasVisible = v;
    }, 1000);
    window.refreshBlitzStats = loadAll;
})();
